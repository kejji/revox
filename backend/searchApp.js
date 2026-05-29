import https from "https";

function getJson(url) {
  return new Promise((resolve) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        },
        (resp) => {
          let data = "";

          resp.on("data", (chunk) => {
            data += chunk;
          });

          resp.on("end", () => {
            resolve({ statusCode: resp.statusCode, body: data });
          });
        }
      )
      .on("error", (err) => {
        console.error("[search-app] http error:", err);
        resolve({ statusCode: 500, body: "" });
      });
  });
}

function extractAndroidAppsFromHtml(html) {
  const results = [];
  const seen = new Set();

  const appIdRegex = /\/store\/apps\/details\?id=([a-zA-Z0-9._]+)/g;

  let match;

  while ((match = appIdRegex.exec(html)) !== null && results.length < 10) {
    const appId = match[1];

    if (seen.has(appId)) continue;
    seen.add(appId);

    const start = Math.max(0, match.index - 1000);
    const end = Math.min(html.length, match.index + 1000);
    const chunk = html.slice(start, end);

    const titleMatch =
      chunk.match(/aria-label="([^"]+)"/) ||
      chunk.match(/title="([^"]+)"/);

    const name = titleMatch?.[1]
      ? titleMatch[1]
          .replace(/&amp;/g, "&")
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
      : appId;

    const iconMatch = chunk.match(/https:\/\/play-lh\.googleusercontent\.com\/[^"\\]+/);

    results.push({
      store: "android",
      name,
      id: appId,
      bundleId: appId,
      icon: iconMatch?.[0] || null,
    });
  }

  return results;
}

async function searchIos(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(
    query
  )}&entity=software&country=FR&limit=5`;

  const { body } = await getJson(url);

  try {
    const json = JSON.parse(body);

    const results = (json.results || []).map((app) => ({
      store: "ios",
      name: app.trackName,
      id: app.trackId.toString(),
      bundleId: app.bundleId,
      icon: app.artworkUrl60,
    }));

    console.log("[search-app] ios results:", results.length);
    return results;
  } catch (e) {
    console.error("[search-app] ios parse error:", e);
    return [];
  }
}

async function searchAndroid(query) {
  const url = `https://play.google.com/store/search?q=${encodeURIComponent(
    query
  )}&c=apps&hl=fr&gl=FR`;

  console.log("[search-app] android direct search start:", query);

  const { statusCode, body } = await getJson(url);

  console.log("[search-app] android direct status:", statusCode);

  const results = extractAndroidAppsFromHtml(body);

  console.log("[search-app] android direct results:", results.length);

  return results;
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