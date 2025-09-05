import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const LINKS_SK = 'APP_LINKS';

const nowIso = () => new Date().toISOString();

export async function ensureLinksDoc(user_id) {
  await ddb.send(new PutCommand({
    TableName: USER_FOLLOWS_TABLE,
    Item: { user_id, app_pk: LINKS_SK, links: {}, updated_at: nowIso() },
    ConditionExpression: 'attribute_not_exists(user_id) AND attribute_not_exists(app_pk)'
  })).catch(err => {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
  });
}

export async function getLinks(user_id) {
  const { Item } = await ddb.send(new GetCommand({
    TableName: USER_FOLLOWS_TABLE,
    Key: { user_id, app_pk: LINKS_SK }
  }));
  return Item?.links || {};
}

export async function linkPair(user_id, a, b) {
  await ensureLinksDoc(user_id);
  await ddb.send(new UpdateCommand({
    TableName: USER_FOLLOWS_TABLE,
    Key: { user_id, app_pk: LINKS_SK },
    UpdateExpression: `
      SET links.#a = list_append(if_not_exists(links.#a, :empty), :bArr),
          links.#b = list_append(if_not_exists(links.#b, :empty), :aArr),
          updated_at = :now
    `,
    ExpressionAttributeNames: { '#a': a, '#b': b },
    ExpressionAttributeValues: {
      ':empty': [],
      ':bArr': [b],
      ':aArr': [a],
      ':now': nowIso()
    }
  }));
}

export async function unlinkPair(user_id, a, b) {
  const links = await getLinks(user_id);
  const next = { ...links };

  const remove = (obj, k, v) => {
    const arr = Array.isArray(obj[k]) ? obj[k] : [];
    const filtered = arr.filter(x => x !== v);
    if (filtered.length) obj[k] = filtered;
    else delete obj[k];
  };

  remove(next, a, b);
  remove(next, b, a);

  await ddb.send(new UpdateCommand({
    TableName: USER_FOLLOWS_TABLE,
    Key: { user_id, app_pk: LINKS_SK },
    UpdateExpression: 'SET links = :links, updated_at = :now',
    ExpressionAttributeValues: { ':links': next, ':now': nowIso() }
  }));
}
