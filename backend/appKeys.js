// backend/appKeys.js
// Helpers partagés pour les endpoints multi-app (app_pk en liste séparée par
// des virgules), utilisés par /mentions et /revox-read.

// app_pk unique ou liste séparée par des virgules (ex. "android#x,ios#y"),
// trim + dédupliqué. Comme GET /reviews.
export function parseAppPks(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

// Clé de stockage canonique pour une combinaison d'apps : la liste triée et
// jointe par virgule. Pour une seule app, la clé = l'app_pk (rétro-compatible
// avec les snapshots existants). Triée pour que l'ordre des apps n'ait pas
// d'importance ("ios#a,android#b" == "android#b,ios#a").
export function canonicalAppKey(appPks) {
  return [...appPks].sort().join(",");
}
