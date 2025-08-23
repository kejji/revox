import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import dotenv from "dotenv";
dotenv.config();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const sqs = new SQSClient({ region: process.env.AWS_REGION });

const TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE;
const QUEUE = process.env.EXTRACTION_QUEUE_URL;

const BATCH_SIZE = parseInt(process.env.SCHED_BATCH_SIZE || "100", 10);
const LOCK_MS = parseInt(process.env.SCHED_LOCK_MS || `${10*60*1000}`, 10);

export const handler = async () => {
  const now = Date.now();

  const q = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: "gsi_due",
    KeyConditionExpression: "due_pk = :due AND next_run_at <= :now",
    ExpressionAttributeValues: { ":due": "DUE", ":now": now },
    Limit: BATCH_SIZE,
    ScanIndexForward: true,
  }));

  for (const it of q.Items ?? []) {
    const { app_pk, interval_minutes = parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES || "120", 10) } = it;

    try {
      // lock
      await ddb.send(new UpdateCommand({
        TableName: TABLE,
        Key: { app_pk },
        ConditionExpression:
          "(attribute_not_exists(in_flight_until) OR in_flight_until < :now) AND next_run_at <= :now",
        UpdateExpression: "SET in_flight_until = :until",
        ExpressionAttributeValues: {
          ":now": now,
          ":until": now + LOCK_MS,
        },
      }));
    } catch {
      continue; // déjà pris ailleurs
    }

    const [platform, bundleId] = app_pk.split("#");
    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE,
      MessageBody: JSON.stringify({
        mode: "incremental",
        platform,
        bundleId,
        backfillDays: 2,
      }),
    }));

    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { app_pk },
      UpdateExpression: "SET next_run_at = :next, last_enqueued_at = :now REMOVE in_flight_until",
      ExpressionAttributeValues: {
        ":next": now + interval_minutes * 60 * 1000,
        ":now": now,
      },
    }));
  }

  return { ok: true, processed: q.Count || 0 };
};
