// backend/themesScheduleRunner.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import crypto from "crypto";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);
const sqs = new SQSClient({ region: process.env.AWS_REGION });

const TABLE = process.env.APPS_THEMES_SCHEDULE_TABLE;
const QUEUE = process.env.THEMES_QUEUE_URL;
const BATCH_SIZE = parseInt(process.env.THEMES_SCHED_BATCH_SIZE || "25", 10);
const LOCK_MS = parseInt(process.env.THEMES_SCHED_LOCK_MS || "60000", 10); // 60s
const DEFAULT_INTERVAL_MIN = parseInt(
  process.env.THEMES_DEFAULT_INTERVAL_MINUTES || "1440",
  10
);

const todayYMD = () => new Date().toISOString().slice(0, 10);
const normalizeAppPkList = (raw) =>
  Array.from(
    new Set(
      String(raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  )
    .sort()
    .join(",");
const makeJobId = (app_pk, day) =>
  "job_" +
  crypto
    .createHash("sha256")
    .update(`${app_pk}|${day}`)
    .digest("hex")
    .slice(0, 16);

export const handler = async () => {
  const now = Date.now();
  console.log(
    JSON.stringify({
      msg: "themes.scheduler.start",
      table: TABLE,
      queue: QUEUE?.split("/").pop(),
      batchSize: BATCH_SIZE,
      lockMs: LOCK_MS,
      defaultIntervalMin: DEFAULT_INTERVAL_MIN,
      now,
      nowIso: new Date(now).toISOString(),
    })
  );

  let processed = 0,
    enqueued = 0,
    locked = 0,
    lockConflicts = 0,
    errors = 0;

  // 1) récupérer les items "due"
  let q;
  try {
    q = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        IndexName: "gsi_due",
        KeyConditionExpression: "due_pk = :due AND next_run_at <= :now",
        ExpressionAttributeValues: { ":due": "DUE", ":now": now },
        Limit: BATCH_SIZE,
        ScanIndexForward: true,
      })
    );
    console.log(
      JSON.stringify({
        msg: "themes.scheduler.query.ok",
        count: q.Count || 0,
        scanned: q.ScannedCount,
        lastEvalKey: !!q.LastEvaluatedKey,
      })
    );
  } catch (e) {
    errors++;
    console.log(
      JSON.stringify({
        msg: "themes.scheduler.query.error",
        error: String(e?.message || e),
      })
    );
    return { ok: false, processed: 0, enqueued: 0, errors };
  }

  // 2) process
  for (const it of q.Items ?? []) {
    processed++;

    // IMPORTANT: on normalise app_pk (garde les duos "ios#...,android#..." dans un ordre stable)
    const app_pk = normalizeAppPkList(it.app_pk);
    const interval_minutes = Number.isFinite(it.interval_minutes)
      ? it.interval_minutes
      : DEFAULT_INTERVAL_MIN;

    if (it.enabled === false) {
      console.log(JSON.stringify({ msg: "themes.skip.disabled", app_pk }));
      continue;
    }

    // lock
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { app_pk },
          ConditionExpression:
            "(attribute_not_exists(in_flight_until) OR in_flight_until < :now) AND next_run_at <= :now",
          UpdateExpression: "SET in_flight_until = :until",
          ExpressionAttributeValues: { ":now": now, ":until": now + LOCK_MS },
        })
      );
      locked++;
      console.log(
        JSON.stringify({
          msg: "themes.lock.ok",
          app_pk,
          untilIso: new Date(now + LOCK_MS).toISOString(),
        })
      );
    } catch {
      lockConflicts++;
      console.log(JSON.stringify({ msg: "themes.lock.conflict", app_pk }));
      continue;
    }

    // enqueue (message multi-app pk tel quel)
    const day = todayYMD();
    const job_id = makeJobId(app_pk, day);
    try {
      console.log(JSON.stringify({
        msg: "themes.scheduler.env",
        queueUrl: QUEUE,
      }));
      const r = await sqs.send(
        new SendMessageCommand({
          QueueUrl: QUEUE,
          MessageBody: JSON.stringify({ app_pk, day, job_id }),
        })
      );
      enqueued++;
      console.log(
        JSON.stringify({
          msg: "themes.sqs.send.ok",
          app_pk,
          messageId: r.MessageId,
          day,
          job_id,
        })
      );
    } catch (e) {
      errors++;
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { app_pk },
            UpdateExpression: "REMOVE in_flight_until",
          })
        );
      } catch {}
      console.log(
        JSON.stringify({
          msg: "themes.sqs.send.error",
          app_pk,
          error: String(e?.message || e),
        })
      );
      continue;
    }

    // replanif
    try {
      const next = now + interval_minutes * 60 * 1000;
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE,
          Key: { app_pk },
          UpdateExpression:
            "SET next_run_at = :next, last_enqueued_at = :now REMOVE in_flight_until",
          ExpressionAttributeValues: { ":next": next, ":now": now },
        })
      );
      console.log(
        JSON.stringify({
          msg: "themes.reschedule.ok",
          app_pk,
          nextRunIso: new Date(next).toISOString(),
          lastEnqueuedAtIso: new Date(now).toISOString(),
        })
      );
    } catch (e) {
      errors++;
      console.log(
        JSON.stringify({
          msg: "themes.reschedule.error",
          app_pk,
          error: String(e?.message || e),
        })
      );
    }
  }

  console.log(
    JSON.stringify({
      msg: "themes.scheduler.end",
      processed,
      locked,
      lockConflicts,
      enqueued,
      errors,
    })
  );
  return { ok: true, processed, enqueued, errors };
};