// routes/searchApp.js
const https = require("https");

exports.searchApp = async (req, res) => {
  const { query } = req.query;
  if (!query || query.length < 2) {
    return res.status(400).json({ error: "Query trop courte" });
  }

  try {
    // Recherche iOS via l’API iTunes
    const iosPromise = new Promise((resolve, reject) => {
      https.get(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&country=FR&limit=5`, resp => {
        let data = "";
        resp.on("data", chunk => (data += chunk));
        resp.on("end", () => {
          try {
            const json = JSON.parse(data);
            const results = json.results.map(app => ({
              store: "ios",
              name: app.trackName,
              id: app.trackId.toString(),
              bundleId: app.bundleId,
              icon: app.artworkUrl60
            }));
            resolve(results);
          } catch (e) {
            reject(e);
          }
        });
      }).on("error", err => reject(err));
    });

    // Recherche Android via API tiers (npm module)
    const { search: gplaySearch } = await import("google-play-scraper");
    const androidResults = await gplaySearch({ term: query, num: 5, country: "fr" });

    const androidApps = androidResults.map(app => ({
      store: "android",
      name: app.title,
      id: app.appId,
      bundleId: app.appId,
      icon: app.icon
    }));

    const iosApps = await iosPromise;

    return res.json([...iosApps, ...androidApps]);
  } catch (err) {
    console.error("Erreur searchApp:", err);
    res.status(500).json({ error: "Recherche échouée" });
  }
};

