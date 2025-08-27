import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const sqs = new SQSClient({ region: process.env.AWS_REGION });

const TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE;
console.log(`TABLE = ${TABLE}`);
const QUEUE = process.env.EXTRACTION_QUEUE_URL;
console.log(`QUEUE = ${QUEUE}`);
const BATCH_SIZE = parseInt(process.env.SCHED_BATCH_SIZE, 10);
console.log(`BATCH_SIZE = ${BATCH_SIZE}`);
const LOCK_MS = parseInt(process.env.SCHED_LOCK_MS, 10);
console.log(`LOCK_MS = ${LOCK_MS}`);
const DEFAULT_INTERVAL_MIN = parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10);
console.log(`DEFAULT_INTERVAL_MIN = ${DEFAULT_INTERVAL_MIN}`);

export const handler = async () => {
  const t0 = Date.now();
  const now = Date.now();

  // Log de démarrage
  console.log(JSON.stringify({
    msg: "scheduler.start",
    table: TABLE,
    queue: QUEUE?.split("/").pop(),
    batchSize: BATCH_SIZE,
    lockMs: LOCK_MS,
    defaultIntervalMin: DEFAULT_INTERVAL_MIN,
    now
  }));

  let processed = 0, enqueued = 0, locked = 0, lockConflicts = 0, errors = 0;

  // 1) Récupère les items "due"
  let q;
  try {
    q = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "gsi_due",
      KeyConditionExpression: "due_pk = :due AND next_run_at <= :now",
      ExpressionAttributeValues: { ":due": "DUE", ":now": now },
      Limit: BATCH_SIZE,
      ScanIndexForward: true,
    }));

    console.log(JSON.stringify({
      msg: "scheduler.query.ok",
      count: q.Count || 0,
      scanned: q.ScannedCount,
      lastEvalKey: !!q.LastEvaluatedKey
    }));
  } catch (e) {
    errors++;
    console.log(JSON.stringify({
      msg: "scheduler.query.error",
      error: String(e?.message || e)
    }));
    return { ok: false, processed: 0, enqueued: 0, errors };
  }

  // 2) Traite chaque item "due"
  for (const it of q.Items ?? []) {
    processed++;

    const app_pk = it.app_pk;
    const appName = it.appName ?? null;
    const interval_minutes = Number.isFinite(it.interval_minutes) ? it.interval_minutes : DEFAULT_INTERVAL_MIN;

    // (Optionnel) si tu veux stopper via enabled=false, décommente la ligne suivante
    // if (it.enabled === false) { console.log(JSON.stringify({ msg: "skip.disabled", app_pk })); continue; }

    // 2a) Lock anti-doublon
    try {
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { app_pk },
        ConditionExpression:
          "(attribute_not_exists(in_flight_until) OR in_flight_until < :now) AND next_run_at <= :now",
        UpdateExpression: "SET in_flight_until = :until",
        ExpressionAttributeValues: { ":now": now, ":until": now + LOCK_MS },
      }));
      locked++;
      console.log(JSON.stringify({ msg: "lock.ok", app_pk }));
    } catch {
      lockConflicts++;
      console.log(JSON.stringify({ msg: "lock.conflict", app_pk }));
      continue; // déjà pris ailleurs
    }

    // 2b) Envoi SQS
    const [platform, bundleId] = String(app_pk).split("#");
    try {
      const r = await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE,
        MessageBody: JSON.stringify({
          mode: "incremental",
          appName,
          platform,
          bundleId,
          backfillDays: 2,
        }),
      }));
      enqueued++;
      console.log(JSON.stringify({ msg: "sqs.send.ok", app_pk, messageId: r.MessageId }));
    } catch (e) {
      errors++;
      // (Facultatif) libère le lock si l'envoi SQS échoue
      try {
        await ddb.send(new UpdateCommand({
          TableName: TABLE,
          Key: { app_pk },
          UpdateExpression: "REMOVE in_flight_until",
        }));
      } catch {}
      console.log(JSON.stringify({ msg: "sqs.send.error", app_pk, error: String(e?.message || e) }));
      continue;
    }

    // 2c) Replanifie
    try {
      const next = now + interval_minutes * 60 * 1000;
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { app_pk },
        UpdateExpression: "SET next_run_at = :next, last_enqueued_at = :now REMOVE in_flight_until",
        ExpressionAttributeValues: { ":next": next, ":now": now },
      }));
      console.log(JSON.stringify({
        msg: "reschedule.ok",
        app_pk,
        nextRunAt: next,
        nextRunIso: new Date(next).toISOString()
      }));
    } catch (e) {
      errors++;
      console.log(JSON.stringify({ msg: "reschedule.error", app_pk, error: String(e?.message || e) }));
    }
  }

  const durMs = Date.now() - t0;
  console.log(JSON.stringify({
    msg: "scheduler.end",
    processed,
    locked,
    lockConflicts,
    enqueued,
    errors,
    durationMs: durMs
  }));

  return { ok: true, processed, enqueued, errors, durationMs: durMs };
};