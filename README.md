# 📱 Revox — Backend (API + BDD)

**Revox** est le **backend** d’une application SaaS qui extrait et analyse les avis utilisateurs des apps mobiles (App Store & Google Play).  
Il expose une **API sécurisée** consommée par un frontend externe (Lovable).

---

## ⚙️ Architecture & Démarrage rapide

- **Backend** : Node.js (Express) + JWT
- **Infra** : AWS (Lambda, API Gateway HTTP API, DynamoDB, SQS, Cognito) via Terraform
- **Frontend** : séparé (Lovable)

```bash
git clone https://github.com/kejji/revox.git
cd revox/infra && terraform init && terraform apply
cd ../backend && cp .env.example .env && npm install && npm run dev
```

---

## 🔐 Authentification

- Auth via **Cognito**.  
- Joindre le JWT dans chaque requête protégée :
```
Authorization: Bearer <JWT_TOKEN>
```

---

## 📘 API Reference

> **toutes** les routes ci‑dessous (hors `/health` et `/search-app`) requièrent un JWT.

### 🟢 Health
**GET** `/health`  
Réponse :
```json
{ "status": "OK" }
```

---

### 🔎 Recherche d’apps
**GET** `/search-app`

| Paramètre | Type   | Requis | Exemple  |
|---|---|---|---|
| `query` | string | ✅ | `notion` |

**Exemple réponse**
```json
[
  { "store":"ios","name":"Notion","id":"123456","bundleId":"com.notionlabs.Notion","icon":"https://..." },
  { "store":"android","name":"Notion","id":"com.notion.android","bundleId":"com.notion.android","icon":"https://..." }
]
```

---

### ⭐ Suivre une app
**POST** `/follow-app`

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android" }
```

**Réponse**
```json
{ "ok": true, "followed": { "bundleId": "com.instagram.android", "platform": "android", "followedAt": "2025-09-01T12:34:56Z" } }
```

---

### ❌ Ne plus suivre une app
**DELETE** `/follow-app`

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android" }
```

**Réponse**
```json
{ "ok": true, "unfollowed": { "bundleId": "com.instagram.android", "platform": "android" } }
```

---

### 📄 Lister les apps suivies
**GET** `/follow-app`

**Réponse**
```json
{
  "followed": [
    { "bundleId":"com.instagram.android","platform":"android","name":"Instagram","icon":"https://..." }
  ]
}
```

---

### 🗂 Lancer une ingestion d’avis
**POST** `/reviews/ingest`

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android", "appName": "Instagram", "backfillDays": 2 }
```

**Réponse**
```json
{
  "ok": true,
  "queued": { "mode":"incremental","appName":"Instagram","platform":"android","bundleId":"com.instagram.android","backfillDays":2 }
}
```

---

### 💬 Récupérer les avis
**GET** `/reviews`

| Paramètre | Type | Requis | Exemple |
|---|---|---|---|
| `platform` | `ios`\|`android` | ✅ | `android` |
| `bundleId` | string | ✅ | `com.instagram.android` |
| `limit` | number |  | `50` |
| `from` / `to` | ISO date |  | `2025-08-01T00:00:00Z` |
| `order` | `asc`\|`desc` |  | `desc` |

**Exemple réponse**
```json
{
  "items": [
    { "date":"2025-09-01T00:00:00Z","rating":4,"text":"Great app!","user_name":"Anonymous","app_version":"298.0.0" }
  ]
}
```

---

### 📤 Export CSV des avis
**GET** `/reviews/export`  
🔁 Identique à `/reviews` côté paramètres. Réponse : fichier `.csv`.

---

### ⏱️ Programmer l’ingestion
**PUT** `/ingest/schedule`

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android", "intervalMinutes": 30 }
```

**Réponse**
```json
{
  "ok": true,
  "scheduled": {
    "appName": "Instagram",
    "app_pk": "android#com.instagram.android",
    "enabled": true,
    "interval_minutes": 30,
    "last_enqueued_at": 1756742462690,
    "next_run_at": 1756744262690,
    "last_enqueued_at_iso": "2025-09-01T16:01:02.690Z",
    "next_run_at_iso": "2025-09-01T16:31:02.690Z",
    "due_pk": "DUE"
  }
}
```

---

### 📊 Consulter la planification d’une app
**GET** `/ingest/schedule`

| Paramètre | Type | Requis | Exemple |
|---|---|---|---|
| `bundleId` | string | ✅ | `com.instagram.android` |
| `platform` | `ios`\|`android` | ✅ | `android` |

**Réponse**
```json
{
  "ok": true,
  "schedule": {
    "appName": "Instagram",
    "app_pk": "android#com.instagram.android",
    "enabled": true,
    "interval_minutes": 30,
    "last_enqueued_at": 1756742462690,
    "next_run_at": 1756744262690,
    "last_enqueued_at_iso": "2025-09-01T16:01:02.690Z",
    "next_run_at_iso": "2025-09-01T16:31:02.690Z",
    "due_pk": "DUE"
  }
}
```

---

### 📋 Lister tous les jobs planifiés
**GET** `/ingest/schedule/list`

**Réponse (réel)**  
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

## 🗃️ Tables DynamoDB (résumé)

| Table                 | PK            | SK         | Description                          |
|---|---|---|---|
| `revox_user_follows`  | `user_id`     | `app_pk`   | Lien user → apps suivies             |
| `apps_metadata`       | `app_key`     | —          | Nom, icône, store ids…               |
| `revox_app_reviews`   | `app_pk`      | `ts_review`| Avis utilisateurs ingérés            |
| `revox_users`         | `id`          | —          | Utilisateurs Cognito                  |
| `apps_ingest_schedule`| `app_pk`      | `due_pk`   | Planification des jobs d’ingestion    |

---

## 🗓️ Dernière mise à jour
Septembre 2025
