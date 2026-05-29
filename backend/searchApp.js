import https from "https";
import gplay from "google-play-scraper";

function searchIos(query) {
  return new Promise((resolve) => {
    https
      .get(
        `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&country=FR&limit=5`,
        (resp) => {
          let data = "";

          resp.on("data", (chunk) => (data += chunk));

          resp.on("end", () => {
            try {
              const json = JSON.parse(data);

              const results = (json.results || []).map((app) => ({
                store: "ios",
                name: app.trackName,
                id: app.trackId.toString(),
                bundleId: app.bundleId,
                icon: app.artworkUrl60,
              }));

              console.log("[search-app] ios results:", results.length);
              resolve(results);
            } catch (e) {
              console.error("[search-app] ios parse error:", e);
              resolve([]);
            }
          });
        }
      )
      .on("error", (err) => {
        console.error("[search-app] ios http error:", err);
        resolve([]);
      });
  });
}

async function searchAndroid(query) {
  try {
    console.log("[search-app] android search start:", query);

    const androidResults = await gplay.search({
      term: query,
      num: 10,
      country: "fr",
      lang: "fr",
      fullDetail: false,
    });

    console.log("[search-app] android raw results:", androidResults?.length || 0);

    return (androidResults || []).map((app) => ({
      store: "android",
      name: app.title,
      id: app.appId,
      bundleId: app.appId,
      icon: app.icon,
    }));
  } catch (err) {
    console.error("[search-app] android error:", err);
    return [];
  }
}

export async function searchApp(req, res) {
  const { query } = req.query;

  console.log("[search-app] query:", query);

  if (!query || query.length < 2) {
    return res.status(400).json({ error: "Query trop courte" });
  }

  const [iosApps, androidApps] = await Promise.all([
    searchIos(query),
    searchAndroid(query),
  ]);

  console.log("[search-app] final results:", {
    ios: iosApps.length,
    android: androidApps.length,
    total: iosApps.length + androidApps.length,
  });

  return res.json([...iosApps, ...androidApps]);
}