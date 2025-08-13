// searchAppMetadata.js
import https from "https";

export async function searchAppMetadata(bundleId, platform) {
  try {
    if (platform === "android") {
      const { default: gplay } = await import("google-play-scraper");
      const app = await gplay.app({ appId: bundleId, country: "fr" });
      return {
        name: app.title,
        icon: app.icon
      };
    }

    if (platform === "ios") {
      return new Promise((resolve, reject) => {
        https.get(`https://itunes.apple.com/lookup?bundleId=${bundleId}&country=FR`, resp => {
          let data = "";
          resp.on("data", chunk => (data += chunk));
          resp.on("end", () => {
            try {
              const json = JSON.parse(data);
              const app = json.results?.[0];
              if (!app) return resolve(null);
              return resolve({
                name: app.trackName,
                icon: app.artworkUrl100
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
