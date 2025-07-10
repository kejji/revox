const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const gplay = require('google-play-scraper');
const store = require('app-store-scraper');
const { Parser } = require('json2csv');
const https = require('https');

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.RESULTS_BUCKET;
const TABLE = process.env.EXTRACTIONS_TABLE;

const s3 = new S3Client({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

function isDateInRange(dateStr, start, end) {
  const d = new Date(dateStr);
  return d >= new Date(start) && d <= new Date(end);
}

function getBundleId(appId) {
  return new Promise((resolve, reject) => {
    const url = `https://itunes.apple.com/lookup?id=${appId}`;
    https.get(url, res => {
      let data = '';
      res.on('data', ch => (data += ch));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const bundleId = json.results?.[0]?.bundleId;
          bundleId ? resolve(bundleId) : reject(new Error('bundleId not found'));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function fetchIOSReviews(appId, startDate, endDate) {
  if (!appId) return [];
  const bundleId = await getBundleId(appId);
  let all = [];
  for (let p = 1; p <= 5; p++) {
    const r = await store.reviews({ appId: bundleId, sort: store.sort.RECENT, country: 'fr', page: p });
    if (!r.length) break;
    all = all.concat(r);
  }
  return all
    .filter(r => isDateInRange(r.updated, startDate, endDate))
    .map(r => ({
      platform: 'iOS',
      date: r.updated,
      rating: r.score,
      text: r.text,
      title: r.title || 'N/A',
      user_name: r.userName,
      app_version: r.version,
      review_id: `ios_${appId}_${r.id}`
    }));
}

async function fetchAndroidReviews(bundleId, startDate, endDate) {
  if (!bundleId) return [];
  const res = await gplay.reviews({ appId: bundleId, sort: gplay.sort.NEWEST, num: 200, lang: 'fr', country: 'fr' });
  return res.data
    .filter(r => isDateInRange(r.date, startDate, endDate))
    .map(r => ({
      platform: 'Android',
      date: r.date,
      rating: r.score,
      text: r.text,
      title: r.title || 'N/A',
      user_name: r.userName,
      app_version: r.version || 'N/A',
      review_id: `android_${bundleId}_${r.id}`
    }));
}

async function handleExtraction(msg) {
  const { userId, extractionId, appName, iosAppId, androidAppId, fromDate, toDate } = msg;
  try {
    const ios = await fetchIOSReviews(iosAppId, fromDate, toDate);
    const android = await fetchAndroidReviews(androidAppId, fromDate, toDate);
    const reviews = [...ios, ...android];
    const fields = ['platform','date','rating','text','title','user_name','app_version','review_id'];
    const csv = new Parser({ fields }).parse(reviews);
    const key = `extractions/${userId}/${extractionId}.csv`;
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: csv, ContentType: 'text/csv' }));
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { user_id: { S: userId }, extraction_id: { S: extractionId } },
      UpdateExpression: 'SET s3_key = :k, status = :s, updated_at = :u',
      ExpressionAttributeValues: {
        ':k': { S: key },
        ':s': { S: 'done' },
        ':u': { S: new Date().toISOString() }
      }
    }));
  } catch (err) {
    console.error('Extraction error', err);
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { user_id: { S: msg.userId }, extraction_id: { S: msg.extractionId } },
      UpdateExpression: 'SET status = :s, error_message = :e, updated_at = :u',
      ExpressionAttributeValues: {
        ':s': { S: 'error' },
        ':e': { S: err.message },
        ':u': { S: new Date().toISOString() }
      }
    }));
  }
}

exports.handler = async (event) => {
  const records = event.Records || [];
  for (const rec of records) {
    const body = JSON.parse(rec.body);
    await handleExtraction(body);
  }
};
