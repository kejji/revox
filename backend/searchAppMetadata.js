// searchAppMetadata.js
import https from "https";

/**
 * Récupère les métadonnées d'une app sur le store en fonction du bundleId et de la plateforme.
 * Retourne : { name, icon, version, rating, releaseNotes, lastUpdatedAt, source }
 */
export async function searchAppMetadata(bundleId, platform) {
  try {
    if (!bundleId || !platform) return null;

    if (platform === "android") {
      const { default: gplay } = await import("google-play-scraper");
      const app = await gplay.app({ appId: bundleId, country: "fr", lang: "fr" });

      return {
        name: app.title,
        icon: app.icon,
        version: app.version ?? null,
        rating: typeof app.score === "number" ? round2(app.score) : null,
        // Les notes de version Play peuvent contenir du HTML (ex : <br/>)
        releaseNotes: app.recentChanges ? stripHtml(app.recentChanges) : null,
        // google-play-scraper expose souvent 'updated' en ms → ISO
        lastUpdatedAt: toISO(app.updated),
        source: "google-play",
      };
    }

    if (platform === "ios") {
      const url = `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=FR`;
      const data = await httpJson(url);
      const app = data?.results?.[0];
      if (!app) return null;

      return {
        name: app.trackName,
        icon: app.artworkUrl512 || app.artworkUrl100 || null,
        version: app.version ?? null,
        rating: typeof app.averageUserRating === "number" ? round2(app.averageUserRating) : null,
        releaseNotes: app.releaseNotes ?? null,
        lastUpdatedAt: app.currentVersionReleaseDate || app.releaseDate || null,
        source: "app-store",
      };
    }

    return null;
  } catch (e) {
    console.warn("searchAppMetadata error:", e?.message || e);
    return null;
  }
}

// ---------- Helpers

function httpJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

const toISO = (v) => {
  try {
    const d = typeof v === "number" ? new Date(v) : new Date(String(v));
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch {
    return null;
  }
};

const round2 = (n) => Math.round(n * 100) / 100;

const stripHtml = (s) =>
  s ? s.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim() : s;