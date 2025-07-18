(async () => {

const { default: gplay } = await import('google-play-scraper');
const { default: store } = await import('app-store-scraper');
const { default: Anthropic } = await import('@anthropic-ai/sdk');

const { Parser } = require('json2csv');
const fs = require('fs');
const https = require('https');
const csv = require('csv-parser');
const path = require('path');
const dotenv = require('dotenv');

// Charger les variables d'environnement depuis .env
dotenv.config();

// Configuration de l'API Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Fonction pour vérifier si une date est dans la plage spécifiée
function isDateInRange(dateStr, startDate, endDate) {
  const date = new Date(dateStr);
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  return date >= start && date <= end;
}

// Fonction pour déterminer la période d'extraction
async function getDatesRange(existingFilePath) {
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  if (!existingFilePath || !fs.existsSync(existingFilePath)) {
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 30);
    defaultStartDate.setHours(0, 0, 0, 0);
    return {
      startDate: defaultStartDate.toISOString().split('T')[0],
      endDate: today.toISOString().split('T')[0]
    };
  }

  return new Promise((resolve, reject) => {
    let latestDate = null;

    fs.createReadStream(existingFilePath)
      .pipe(csv())
      .on('data', row => {
        const reviewDate = new Date(row.date);
        if (!latestDate || reviewDate > latestDate) {
          latestDate = reviewDate;
        }
      })
      .on('end', () => {
        if (!latestDate) {
          const defaultStartDate = new Date();
          defaultStartDate.setDate(defaultStartDate.getDate() - 30);
          defaultStartDate.setHours(0, 0, 0, 0);
          resolve({
            startDate: defaultStartDate.toISOString().split('T')[0],
            endDate: today.toISOString().split('T')[0]
          });
        } else {
          latestDate.setDate(latestDate.getDate() + 1);
          latestDate.setHours(0, 0, 0, 0);
          resolve({
            startDate: latestDate.toISOString().split('T')[0],
            endDate: today.toISOString().split('T')[0]
          });
        }
      })
      .on('error', reject);
  });
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

// Fonction pour lire les commentaires existants
async function readExistingReviews(filePath) {
  const existingReviews = new Map();
  if (!filePath || !fs.existsSync(filePath)) return existingReviews;

  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        existingReviews.set(row.review_id, row);
      })
      .on('end', () => {
        console.log(`${existingReviews.size} commentaires existants lus depuis ${filePath}`);
        resolve(existingReviews);
      })
      .on('error', reject);
  });
}

// Fonction pour récupérer les avis iOS
async function getIOSReviews(appName, appId, startDate, endDate) {
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
async function getAndroidReviews(appName, bundleId, startDate, endDate) {
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
async function processApp(appName, iosAppId, androidBundleId, startDate, endDate) {
  try {
    console.log(`\nTraitement de ${appName}`);
    console.log(`Période d'extraction : du ${startDate} au ${endDate}`);

    // Récupérer les nouveaux avis
    const [iosReviews, androidReviews] = await Promise.all([
      getIOSReviews(appName, iosAppId, startDate, endDate),
      getAndroidReviews(appName, androidBundleId, startDate, endDate)
    ]);

    // Concaténer tous les avis, sans se soucier des doublons
    const allReviews = [...iosReviews, ...androidReviews];

    if (allReviews.length > 0) {
      // Trier par date décroissante
      allReviews.sort((a, b) => new Date(b.date) - new Date(a.date));
      
      console.log(`Nombre total d'avis : ${allReviews.length}`);

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

      const json2csvParser = new Parser({ fields });
      const csv = json2csvParser.parse(allReviews);
      return csv;
    }
    return 0;
  } catch (error) {
    console.error(`Erreur lors du traitement de ${appName}:`, error);
    return 0;
  }
}

// Fonction pour analyser les commentaires avec Claude
async function analyzeReviewsWithClaude(reviews, appName) {
    try {
        console.log(`Début de l'analyse pour ${appName} avec ${reviews.length} commentaires...`);
        
        // Limiter le nombre de commentaires pour éviter les timeouts
        const maxReviews = 50; // On limite à 50 commentaires pour l'analyse
        const sampleReviews = reviews.slice(0, maxReviews);
        
        console.log(`Analyse limitée aux ${sampleReviews.length} commentaires les plus récents`);

        // Préparation des commentaires pour l'analyse
        const reviewsText = sampleReviews.map(review =>
            `Note: ${review.rating}/5
             Date: ${review.date}
             Commentaire: ${review.text}`
        ).join('\n\n');

        console.log('Envoi de la requête à Claude...');

        // Prompt pour Claude
        const prompt = `Tu es un expert en analyse de commentaires d'applications mobiles. 
        Analyse les commentaires suivants pour l'application ${appName} et identifie de manière concise :
        1. Top 3 des points positifs (satisfaction utilisateur)
        2. Top 3 des points négatifs (irritants)
        
        Format de réponse souhaité :
        POINTS POSITIFS :
        1. [Point] - [Brève explication]
        2. [Point] - [Brève explication]
        3. [Point] - [Brève explication]

        POINTS NÉGATIFS :
        1. [Point] - [Brève explication]
        2. [Point] - [Brève explication]
        3. [Point] - [Brève explication]

        Voici les commentaires à analyser :
        ${reviewsText}`;

        // Appel à l'API Claude avec timeout
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout - L\'analyse a pris trop de temps')), 60000);
        });

        const analysisPromise = anthropic.messages.create({
            model: 'claude-3-opus-20240229',
            max_tokens: 1000,
            temperature: 0,
            messages: [{
                role: 'user',
                content: prompt
            }]
        });

        const message = await Promise.race([analysisPromise, timeoutPromise]);
        
        console.log('Réponse reçue de Claude');
        return message.content[0].text;

    } catch (error) {
        console.error(`Erreur lors de l'analyse des commentaires avec Claude pour ${appName}:`, error);
        return `Erreur d'analyse : ${error.message}`;
    }
}

// Fonction modifiée pour générer un rapport par application
async function generateAnalysisReport(app) {
    try {
        const today = new Date().toISOString().split('T')[0];
        const sanitizedAppName = app.name.replace(/[^a-zA-Z0-9]/g, '_');
        const reportFileName = `analysis_${sanitizedAppName}_${today}.txt`;
        
        console.log(`\nAnalyse des commentaires pour ${app.name}...`);
        
        // Récupérer tous les commentaires depuis le fichier existant
        const existingReviews = await readExistingReviews(app.existingFile);
        const reviews = Array.from(existingReviews.values());

        let reportContent = '';
        reportContent += `Rapport d'analyse des commentaires - ${app.name}\n`;
        reportContent += `Date: ${today}\n`;
        reportContent += `${'='.repeat(50)}\n\n`;

        // Si des commentaires existent, les analyser
        if (reviews.length > 0) {
            // Statistiques générales
            const iosReviews = reviews.filter(r => r.platform === 'iOS').length;
            const androidReviews = reviews.filter(r => r.platform === 'Android').length;
            const avgRating = reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length;

            reportContent += `STATISTIQUES GÉNÉRALES\n`;
            reportContent += `-------------------\n`;
            reportContent += `Nombre total de commentaires: ${reviews.length}\n`;
            reportContent += `Commentaires iOS: ${iosReviews}\n`;
            reportContent += `Commentaires Android: ${androidReviews}\n`;
            reportContent += `Note moyenne: ${avgRating.toFixed(2)}/5\n\n`;

            const analysis = await analyzeReviewsWithClaude(reviews, app.name);
            
            if (analysis) {
                reportContent += `ANALYSE DÉTAILLÉE\n`;
                reportContent += `----------------\n`;
                reportContent += analysis;
            }
        } else {
            reportContent += `Aucun commentaire disponible pour analyse.\n`;
        }

        // Sauvegarder le rapport
        await fs.promises.writeFile(reportFileName, reportContent);
        console.log(`Rapport d'analyse sauvegardé dans ${reportFileName}`);

    } catch (error) {
        console.error(`Erreur lors de la génération du rapport pour ${app.name}:`, error);
    }
}

})();
