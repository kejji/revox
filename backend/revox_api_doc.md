# 📘 Revox API – Documentation Backend

Dernière mise à jour : 2025-08-13

---

## 🔐 Authentification

Toutes les routes (sauf `/health` et `/search-app`) nécessitent un header :

```
Authorization: Bearer <JWT_TOKEN>
```

Le backend extrait automatiquement `req.auth.sub` pour identifier l’utilisateur.

---

## 🟢 `GET /health`

### ✅ Description
Permet de vérifier si l’API est en ligne.

### 🔄 Réponse
```json
{
  "status": "OK"
}
```

---

## 🔎 `GET /search-app`

### ✅ Description
Recherche d’applications mobiles à partir d’un nom.

### 📥 Query params

| Paramètre | Type   | Obligatoire | Exemple     |
|-----------|--------|-------------|-------------|
| `query`   | string | ✅          | `notion`    |

### 🔄 Réponse
```json
[
  {
    "store": "ios",
    "name": "Notion",
    "id": "123456",
    "bundleId": "com.notionlabs.Notion",
    "icon": "https://..."
  },
  {
    "store": "android",
    "name": "Notion",
    "id": "com.notion.android",
    "bundleId": "com.notion.android",
    "icon": "https://..."
  }
]
```

---

## ⭐ `POST /follow-app`

### ✅ Description
Permet à l'utilisateur de suivre une app.

### 📥 Body JSON
```json
{
  "bundleId": "com.instagram.android",
  "platform": "android"
}
```

### 🔄 Réponse
```json
{
  "ok": true,
  "followed": {
    "bundleId": "com.instagram.android",
    "platform": "android",
    "followedAt": "2025-08-13T12:34:56Z"
  }
}
```

---

## ❌ `DELETE /follow-app`

### ✅ Description
Permet à l'utilisateur de ne plus suivre une app.

### 📥 Body JSON
```json
{
  "bundleId": "com.instagram.android",
  "platform": "android"
}
```

### 🔄 Réponse
```json
{
  "ok": true,
  "unfollowed": {
    "bundleId": "com.instagram.android",
    "platform": "android"
  }
}
```

---

## 📄 `GET /follow-app`

### ✅ Description
Retourne la liste des apps suivies par l’utilisateur, enrichies avec leur nom et icône.

### 🔄 Réponse
```json
{
  "followed": [
    {
      "bundleId": "com.instagram.android",
      "platform": "android",
      "name": "Instagram",
      "icon": "https://..."
    }
  ]
}
```

---

## 🗂 `POST /reviews/ingest`

### ✅ Description
Déclenche une extraction des derniers avis d'une app.

### 📥 Body JSON
```json
{
  "bundleId": "com.instagram.android",
  "platform": "android",
  "appName": "Instagram",
  "backfillDays": 2
}
```

### 🔄 Réponse
```json
{
  "ok": true,
  "queued": {
    "mode": "incremental",
    "appName": "Instagram",
    "platform": "android",
    "bundleId": "com.instagram.android",
    "backfillDays": 2
  }
}
```

---

## 💬 `GET /reviews`

### ✅ Description
Retourne les avis d’une app triés par date (desc).

### 📥 Query params (auth requis)
- `platform`: `ios` ou `android` ✅
- `bundleId`: string ✅
- `limit`: nombre d’avis (max 100)
- `from` / `to`: dates ISO (optionnel)
- `order`: `asc` ou `desc`

---

## 📤 `GET /reviews/export`

### ✅ Description
Télécharge les avis au format CSV.

### 📥 Query params identiques à `/reviews`

🔁 Réponse = fichier `.csv` avec les colonnes :  
`app_name`, `platform`, `date`, `rating`, `text`, `user_name`, `app_version`, `bundle_id`
