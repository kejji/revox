const https = require("https");

exports.searchApp = async (req, res) => {
  const { query } = req.query;
  console.log("Requête reçue sur /search-app avec query:", query);

  if (!query || query.length < 2) {
    return res.status(400).json({ error: "Query trop courte" });
  }

  try {
    // Importer dynamiquement les modules ESM
    const { default: gplay } = await import("google-play-scraper");
    console.log("google-play-scraper importé");
    // Recherche iOS via l’API iTunes
    console.log("Lancement de la requête iTunes...");
    const iosPromise = new Promise((resolve, reject) => {
      https.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&country=FR&limit=5`, resp => {
        console.log("Réponse iTunes reçue, status:", resp.statusCode);
        let data = "";
        resp.on("data", chunk => (data += chunk));
        resp.on("end", () => {
          console.log("Flux iTunes terminé, parsing JSON...");
          try {
            const json = JSON.parse(data);
            const results = json.results.map(app => ({
              store: "ios",
              name: app.trackName,
              id: app.trackId.toString(),
              bundleId: app.bundleId,
              icon: app.artworkUrl60
            }));
            console.log("Résultats iOS extraits:", results.length);
            resolve(results);
          } catch (e) {
            console.error("Erreur de parsing iTunes:", e);
            reject(e);
          }
        });
      }).on("error", err => {
        console.error("Erreur HTTP iTunes:", err);  
        reject(err);
        });
    });

    // Recherche Android via gplay
    console.log("Recherche Android via google-play-scraper...");
    const androidResults = await gplay.search({ term: query, num: 5, country: "fr" });
    console.log("Résultats Android récupérés:", androidResults.length);
    const androidApps = androidResults.map(app => ({
      store: "android",
      name: app.title,
      id: app.appId,
      bundleId: app.appId,
      icon: app.icon
    }));

    const iosApps = await iosPromise;
    console.log("Fusion des résultats iOS + Android...");
    return res.json([...iosApps, ...androidApps]);
  } catch (err) {
    console.error("Erreur searchApp:", err);
    res.status(500).json({ error: "Recherche échouée" });
  }
};

