import dotenv from "dotenv";
dotenv.config();

// 1. Imports synchrones en CommonJS
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { Parser } = require("json2csv");
const https = require("https");

// 2. Instanciation des clients AWS
const s3 = new S3Client({ region: "eu-west-3" });
const db = new DynamoDBClient({ region: "eu-west-3" });

exports.handler = async (event) => {
  // Import dynamiques des ESM
  const { default: gplay } = await import("google-play-scraper");
  const { default: store } = await import("app-store-scraper");

  for (const record of event.Records) {
    let message = null;

    try {
      message = JSON.parse(record.body);
      const { userId, extractionId, appName, appId, platform, fromDate, toDate } = message;

      console.log("🛠️ Traitement extraction", extractionId);

      // Étape 1 : générer le contenu CSV
      const content = await processApp({ store, gplay, appName, platform, appId, fromDate, toDate });
      
      // Étape 2 : envoyer vers S3
      const s3Key = `${appName}-${appId}/${userId}/${extractionId}.csv`;

      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: s3Key,
        Body: content,
        ContentType: "text/csv",
      }));

      console.log("CSV généré et envoyé à S3 :", s3Key);

      // Étape 3 : mise à jour DynamoDB
      await db.send(new UpdateItemCommand({
        TableName: process.env.EXTRACTIONS_TABLE,
        Key: {
          user_id: { S: userId },
          extraction_id: { S: extractionId },
        },
        UpdateExpression: "SET #s = :s, s3_key = :k, updated_at = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": { S: "done" },
          ":k": { S: s3Key },
          ":now": { S: new Date().toISOString() },
        }
      }));

      console.log("Table DynamoDB mise à jour");
    } catch (error) {
      console.error("Erreur dans le worker :", error);

      if (message?.userId && message?.extractionId) {
        try {
          await db.send(new UpdateItemCommand({
            TableName: process.env.EXTRACTIONS_TABLE,
            Key: {
              user_id: { S: message.userId },
              extraction_id: { S: message.extractionId },
            },
            UpdateExpression: "SET #s = :s, error_message = :msg, updated_at = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":s":   { S: "error" },
              ":msg": { S: error.message || "Erreur inconnue" },
              ":now": { S: new Date().toISOString() },
            }
          }));
          console.log("Statut mis à jour dans DynamoDB en erreur");
        } catch (updateErr) {
          console.error("Échec de mise à jour du statut d'erreur :", updateErr);
        }
      }
    }
  }
};


// Fonction pour vérifier si une date est dans la plage spécifiée
function isDateInRange(dateStr, startDate, endDate) {
  const date = new Date(dateStr);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  return date >= start && date <= end;
}

// Fonction pour récupérer le bundleId via l'API iTunes
function getBundleId(appId) {
  return new Promise((resolve, reject) => {
    const url = `https://itunes.apple.com/lookup?id=${appId}`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.results?.[0]?.bundleId) {
            resolve(json.results[0].bundleId);
          } else {
            reject(`Impossible de trouver le bundleId pour l'App ID ${appId}`);
          }
        } catch (err) {
          reject(`Erreur parsing iTunes pour l'App ID ${appId} : ${err}`);
        }
      });
    }).on('error', err => {
      reject(`Erreur de connexion à l'API iTunes : ${err.message}`);
    });
  });
}


// Fonction pour récupérer les avis iOS
async function getIOSReviews(store,appName, appId, startDate, endDate) {
  try {
    if (!appId || appId === 'N/A') {
      console.log(`Pas d'App ID iOS pour ${appName}, ignoré.`);
      return [];
    }

    console.log(`\nRécupération des avis iOS pour ${appName} (App ID: ${appId})`);
    console.log(`Période: du ${startDate} au ${endDate}`);
    
    const bundleId = await getBundleId(appId);
    console.log(`Bundle ID trouvé : ${bundleId}`);

    let allReviews = [];
    let currentPage = 1;
    const MAX_PAGES = 10;
    let hasMoreReviews = true;
    let hasReviewsInRange = true;

    while (hasMoreReviews && currentPage <= MAX_PAGES && hasReviewsInRange) {
      console.log(`iOS : Page ${currentPage}/${MAX_PAGES}`);
      try {
        const reviews = await store.reviews({
          appId: bundleId,
          sort: store.sort.RECENT,
          country: 'fr',
          page: currentPage
        });

        if (reviews.length === 0) {
          hasMoreReviews = false;
        } else {
          // Filtrer et normaliser les avis iOS
          const filteredReviews = reviews
            .filter(review => isDateInRange(review.updated, startDate, endDate))
            .map(review => ({
              app_name: appName,
              platform: 'iOS',
              date: review.updated,
              rating: review.score,
              text: review.text,
              title: 'N/A',
              user_name: review.userName,
              app_version: review.version,
              app_id: appId,
              bundle_id: bundleId,
              review_id: `ios_${bundleId}_${review.id || Date.now()}`,
              reply_date: null,
              reply_text: null
            }));
            
          // Si aucun avis de la page n'est dans la plage de dates, on arrête
          if (filteredReviews.length === 0 && reviews[reviews.length - 1].updated < new Date(startDate)) {
            hasReviewsInRange = false;
            console.log('Plus d\'avis dans la plage de dates spécifiée.');
          } else {
            allReviews = allReviews.concat(filteredReviews);
            currentPage++;
            await new Promise(resolve => setTimeout(resolve, 1500));
          }
        }
      } catch (error) {
        console.error(`Erreur lors de la récupération de la page ${currentPage}:`, error);
        hasMoreReviews = false;
      }
    }

    console.log(`Total des avis iOS pour ${appName} dans la période: ${allReviews.length}`);
    return allReviews;
  } catch (error) {
    console.error(`Erreur lors de la récupération des avis iOS pour ${appName}:`, error);
    return [];
  }
}

// Fonction pour récupérer les avis Android
async function getAndroidReviews(gplay, appName, bundleId, startDate, endDate) {
  try {
    if (!bundleId || bundleId === 'N/A') {
      console.log(`Pas de bundle ID Android pour ${appName}, ignoré.`);
      return [];
    }

    console.log(`\nRécupération des avis Android pour ${appName} (Bundle ID: ${bundleId})`);
    console.log(`Période: du ${startDate} au ${endDate}`);

    let initialNum = 100;  // On commence plus petit pour tester
    let maxNum = 10000;    // Limite maximale réduite
    let currentNum = initialNum;
    let allReviews = new Map(); // Utilisation d'une Map pour la déduplication
    let hasReviewsInRange = true;
    let targetStartDate = new Date(startDate);

    while (hasReviewsInRange && currentNum <= maxNum) {
      console.log(`Android : Tentative de récupération avec num=${currentNum} avis...`);
      
      try {
        const result = await gplay.reviews({
          appId: bundleId,
          sort: gplay.sort.NEWEST,
          num: currentNum,
          lang: 'fr',
          country: 'fr'
        });

        if (!result.data || result.data.length === 0) {
          console.log('Aucun avis disponible.');
          break;
        }

        // Filtrer et normaliser les avis dans la plage de dates
        result.data
          .filter(review => isDateInRange(review.date, startDate, endDate))
          .forEach(review => {
            const reviewId = `android_${bundleId}_${review.id}`;
            if (!allReviews.has(reviewId)) {
              allReviews.set(reviewId, {
                app_name: appName,
                platform: 'Android',
                date: review.date,
                rating: review.score,
                text: review.text,
                title: review.title || 'N/A',
                user_name: review.userName,
                app_version: review.version || 'N/A',
                app_id: bundleId,
                bundle_id: bundleId,
                review_id: reviewId,
                reply_date: review.replyDate || null,
                reply_text: review.replyText || null
              });
            }
          });

        // Vérifier la date du dernier avis récupéré
        const oldestReviewDate = new Date(result.data[result.data.length - 1].date);
        console.log(`Date du plus ancien avis récupéré: ${oldestReviewDate.toISOString()}`);
        console.log(`Nombre d'avis dans la plage: ${allReviews.size}`);

        // Vérifier si on a atteint la date de début
        if (oldestReviewDate > targetStartDate && currentNum < maxNum) {
          currentNum += 100; // Augmentation plus progressive
          console.log('La plage de dates n\'est pas entièrement couverte, augmentation de num');
          await new Promise(resolve => setTimeout(resolve, 1500));
        } else {
          hasReviewsInRange = false;
          console.log('Fin de la récupération des avis Android');
        }

      } catch (error) {
        console.error(`Erreur lors de la récupération des avis avec num=${currentNum}:`, error);
        break;
      }
    }

    const normalizedReviews = Array.from(allReviews.values());
    console.log(`Total des avis Android pour ${appName} dans la période: ${normalizedReviews.length}`);
    return normalizedReviews;

  } catch (error) {
    console.error(`Erreur lors de la récupération des avis Android pour ${appName}:`, error);
    return [];
  }
}

// Fonction pour traiter une application
async function processApp({ store, gplay, appName, platform, appId, fromDate, toDate }) {
  console.log(`\nTraitement de ${appName} (${platform})`);
  let allReviews = [];

  if (platform === "ios") {
    allReviews = await getIOSReviews(store, appName, appId, fromDate, toDate);
  } else if (platform === "android") {
    allReviews = await getAndroidReviews(gplay, appName, appId, fromDate, toDate);
  } else {
    throw new Error("Plateforme inconnue : " + platform);
  }

  if (allReviews.length === 0) return 0;

  allReviews.sort((a, b) => new Date(b.date) - new Date(a.date));

  const fields = [
    'app_name',
    'platform',
    'date',
    'rating',
    'text',
    'title',
    'user_name',
    'app_version',
    'app_id',
    'bundle_id',
    'review_id',
    'reply_date',
    'reply_text'
  ];

  const parser = new Parser({ fields });
  return parser.parse(allReviews);
}