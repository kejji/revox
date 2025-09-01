# 📘 Revox API – Documentation Backend

Dernière mise à jour : 2025-09-01

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
    "followedAt": "2025-09-01T12:34:56Z"
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

---

## ⏱️ `PUT /ingest/schedule`

### ✅ Description
Planifie ou met à jour le job d’ingestion automatique d’une application suivie.

### 📥 Body JSON
```json
{
    "platform": "android",
    "appName": "Fortuneo - la banque en ligne",
    "bundleId": "com.fortuneo.android",
    "interval_minutes": 3,
    "enabled": true
}
```

### 🔄 Réponse
```json
{
  "ok": true,
  "schedule": {
      "appName": "Fortuneo - la banque en ligne",
      "app_pk": "android#com.fortuneo.android",
      "due_pk": "DUE",
      "enabled": true,
      "interval_minutes": 30,
      "last_enqueued_at": 1756742462690,
      "next_run_at": 1756744262690
  },
  "updated": false
}
```

---

## 📊 `GET /ingest/schedule`

### ✅ Description
Retourne la planification en cours pour une application suivie.

### 📥 Query params
- `bundleId`: string ✅
- `platform`: `ios` ou `android` ✅

### 🔄 Réponse
```json
{
  "ok": true,
  "schedule": {
      "appName": "Fortuneo - la banque en ligne",
      "app_pk": "android#com.fortuneo.android",
      "due_pk": "DUE",
      "enabled": true,
      "interval_minutes": 30,
      "last_enqueued_at": 1756742462690,
      "next_run_at": 1756744262690,
      "last_enqueued_at_iso": "2025-09-01T16:01:02.690Z",
      "next_run_at_iso": "2025-09-01T16:31:02.690Z"
  }
}
```

---

## 📋 `GET /ingest/schedule/list`

### ✅ Description
Liste tous les jobs d’ingestion planifiés pour l’utilisateur.

### 🔄 Réponse
```json
{
  "ok": true,
  "items": [
    {
      "appName": "Fortuneo - la banque en ligne",
      "app_pk": "android#com.fortuneo.android",
      "enabled": true,
      "interval_minutes": 30,
      "last_enqueued_at": 1756742462690,
      "next_run_at": 1756744262690,
      "due_pk": "DUE",
      "last_enqueued_at_iso": "2025-09-01T16:01:02.690Z",
      "next_run_at_iso": "2025-09-01T16:31:02.690Z"
    }
  ],
  "nextCursor": null
}
```

---
