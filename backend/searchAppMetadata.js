// searchAppMetadata.js
import https from "https";

export async function searchAppMetadata(bundleId, platform) {
  try {
    if (platform === "android") {
      const { default: gplay } = await import("google-play-scraper");
      const app = await gplay.app({ appId: bundleId, country: "fr", lang: "fr" });
      return {
        name: app.title,
        icon: app.icon,
        version: app.version ?? null,
        rating: typeof app.score === "number" ? round2(app.score) : null,
        ratingCount: (app.ratings ?? app.ratingsCount) ?? null,
        releaseNotes: app.recentChanges ? stripHtml(app.recentChanges) : null,
        // 'updated' souvent en ms -> ISO
        lastUpdatedAt: toISO(app.updated),
        source: "google-play"
      };
    }

    if (platform === "ios") {
      return new Promise((resolve, reject) => {
        const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=FR`;
        https.get(url, resp => {
          let data = "";
          resp.on("data", chunk => (data += chunk));
          resp.on("end", () => {
            try {
              const json = JSON.parse(data);
              const app = json.results?.[0];
              if (!app) return resolve(null);
              resolve({
                name: app.trackName,
                icon: app.artworkUrl512 || app.artworkUrl100 || null,
                version: app.version ?? null,
                rating: typeof app.averageUserRating === "number" ? round2(app.averageUserRating) : null,
                ratingCount: app.userRatingCount ?? null,
                releaseNotes: app.releaseNotes ?? null,
                lastUpdatedAt: app.currentVersionReleaseDate || app.releaseDate || null,
                source: "app-store"
              });
            } catch (e) {
              reject(e);
            }
          });
        }).on("error", reject);
      });
    }

    return null;
  } catch (e) {
    console.warn("searchAppMetadata error:", e.message);
    return null;
  }
}

// ---- Helpers
const toISO = (v) => {
  try {
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch { return null; }
};
const round2 = (n) => Math.round(n * 100) / 100;
// Nettoie le HTML des notes de version Google Play
const stripHtml = (s) =>
  s ? s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : s;
