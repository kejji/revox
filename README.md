# 📱 Revox — Backend (API + BDD)

**Revox** est un **backend** qui extrait et analyse les avis utilisateurs des apps mobiles (App Store & Google Play).  
Il expose une **API sécurisée** consommée par un frontend externe.

---

## ⚙️ Architecture & Démarrage rapide

- **Backend** : Node.js (Express) + JWT
- **Infra** : AWS (Lambda, API Gateway HTTP API, DynamoDB, SQS, Cognito) via Terraform
- **Frontend** : séparé

```bash
git clone https://github.com/kejji/revox.git
cd revox/infra && terraform init && terraform apply
cd ../backend && cp .env.example .env && npm install && npm run dev
```

---

## 🔐 Authentification

- Auth via **Cognito**.  
- Joindre le JWT dans chaque requête protégée :
```
Authorization: Bearer <JWT_TOKEN>
```

---

## 📘 API

> **Toutes** les routes ci-dessous (hors `/health`) requièrent un JWT.

### 🟢 Health
**GET** `/health`  
Réponse :  
```json
{ "status": "OK" }
```

---

### 🔎 Recherche d’apps
**GET** `/search-app`  
Recherche d’apps sur iOS/Android à partir d’un mot-clé.
**Exemple réponse**
```json
[
  { "store":"ios","name":"Notion","id":"123456","bundleId":"com.notionlabs.Notion","icon":"https://..." }, { "store":"android","name":"Notion","id":"com.notion.android","bundleId":"com.notion.android","icon":"https://..." }
]
```

---

### ⭐ Suivre une app
**POST** `/follow-app`  
**Description** : Lie l’app à l’utilisateur et planifie automatiquement l’ingestion (`PUT /ingest/schedule`). Idempotent.  

**Body (JSON)**
```json
{ "bundleId": "com.fortuneo.fortuneo", "platform": "ios" }
```

**Réponse**
```json
{
  "ok": true,
  "followed": {
    "bundleId": "com.fortuneo.fortuneo",
    "platform": "ios",
    "followedAt": "2025-09-14T22:03:25.228Z"
  },
  "schedule": {
    "created": false,
    "schedule": {
      "app_pk": "ios#com.fortuneo.fortuneo",
      "created_at": 1757885697963,
      "created_at_iso": "2025-09-14T21:34:57.963Z",
      "due_pk": "DUE",
      "enabled": true,
      "interval_minutes": 30,
      "last_enqueued_at": 1757885698301,
      "last_enqueued_at_iso": "2025-09-14T21:34:58.301Z",
      "next_run_at": 1757887498301,
      "next_run_at_iso": "2025-09-14T22:04:58.301Z"
    }
  }
}
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
**Description** : Retourne toutes les apps suivies par l’utilisateur, enrichies avec :
- métadonnées (nom, icône, version, rating, releaseNotes…),
- liens éventuels (`linked_app_pks`),
- compteurs de nouveaux avis (`badge_count`, `total_reviews`, `last_seen_total`, `last_seen_at`).

**Réponse**
```json
{
  "followed": [
    {
      "bundleId":"com.instagram.android",
      "platform":"android",
      "name":"Instagram",
      "icon":"https://...",
      "version":"123.0.0",
      "rating":4.2,
      "releaseNotes":"Bug fixes and improvements",
      "lastUpdatedAt":"2025-09-10T12:34:56Z",
      "linked_app_pks": ["ios#com.fortuneo.fortuneo"],
      "badge_count": 7,
      "total_reviews": 1234,
      "last_seen_total": 1227,
      "last_seen_at": "2025-09-13T22:04:11.091Z"
    }
  ]
}
```
---

**PUT** `/follow-app/mark-read`  
**Description** : Marque une app comme “vue” par l’utilisateur et remet le compteur de badge à zéro.  

**Body**
```json
{ "platform": "android", "bundleId": "com.fortuneo.android" }
```

**Réponse**
```json
{
  "ok": true,
  "app_pk": "android#com.fortuneo.android",
  "last_seen_total": 1234,
  "last_seen_at": "2025-09-14T09:01:22.000Z"
}
```

---

### 🧷 Fusion d’applications
**POST** `/apps/merge`  
**DELETE** `/apps/merge`  

**Body (JSON)**
```json
{ "app_pks": ["android#<bundleId>", "ios#<bundleId>"] }
```
---

### 💬 Récupérer les avis
**GET** `/reviews`  
**Description** : Récupère les avis stockés. Supporte **mono** ou **multi-apps** via **un seul** paramètre `app_pk`. Pagination **par curseur**.  

**Query params** :  
| Paramètre   | Type                 | Requis | Exemple |
|-------------|----------------------|--------|---------|
| `app_pk`    | string (mono **ou** liste séparée par virgules) | ✅ | `android%23com.fortuneo.android,ios%23310633997` |
| `limit`     | number (1..200)      | optionnel | `50` |
| `order`     | `asc`\|`desc`        | optionnel | `desc` |
| `cursor`    | string (opaque)      | optionnel | jeton renvoyé par l’appel précédent |

**Exemple**
```http
GET /reviews?app_pk=android%23com.fortuneo.android,ios%23310633997&limit=50
```
**Réponse**
```json
{ "items":[ ... ], "nextCursor":"...", "count":50 }
```

> Note: pour compat héritée, `platform` + `bundleId` peuvent encore être acceptés si vous avez conservé le “pont” (optionnel).

---

### 🗂 Ingestion d’avis
**POST** `/reviews/ingest`  
Déclenche une ingestion manuelle.  
**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android", "appName": "Instagram", "backfillDays": 2 }
```
---

### 📤 Export CSV des avis
**GET** `/reviews/export`  
**Description** : Export CSV sur une **plage de dates**, en mono ou multi-apps. Pas de `limit` exposé — l’API renvoie **l’intégralité** des avis dans `[from, to]`.  

**Query params** :  
| Paramètre | Type | Requis | Exemple |
|---|---|---|---|
| `app_pk` | string (mono ou multi, séparé par virgules) | ✅ | `android%23com.fortuneo.android,ios%23310633997` |
| `from` / `to` | ISO date | ✅ | `2025-07-01T00:00:00.000Z` / `2025-09-05T23:59:59.999Z` |
| `order` | `asc`\|`desc` | optionnel | `desc` |

**Colonnes CSV** : `app_pk, platform, bundle_id, date, ts_review, rating, user_name, app_version, source, text`

> Implémentation : filtre côté DynamoDB via `KeyCondition` sur `ts_review` (`BETWEEN`/`>=`/`<=`), merge **k-way** des flux multi-apps, pagination interne. Encoder `#` dans l’URL (`%23`).

---

### ⏱️ Programmer l’ingestion
**PUT** `/ingest/schedule`  
**GET** `/ingest/schedule`  
**GET** `/ingest/schedule/list`

---

### 🧑‍🔬 Analyse de thèmes

#### 1. Lancer une analyse (envoi message SQS)
**POST** `/themes/enqueue`  
**Body** (limit)
```json
{ "app_pk": "android#com.fortuneo.android,ios#com.fortuneo.fortuneo", "limit": 100 }
```
ou (from/to)
```json
{"app_pk":"ios#com.fortuneo.fortuneo,android#com.fortuneo.android","from":"2025-06-17T00:00:00.000Z","to":"2025-09-17T00:00:00.000Z"}
```
→ Crée un item `pending#<day>#<job_id>` et envoie un message SQS pour le worker.

---

#### 2. Vérifier l’état
**GET** `/themes/status?app_pk=<...>&job_id=<...>&day=<YYYY-MM-DD>`  

Réponse typique :  
```json
{ "ok": true, "status": "pending" }
```
ou  
```json
{ "ok": true, "status": "failed", "error": "OpenAI timeout" }
```

---

#### 3. Récupérer le résultat final
**GET** `/themes/result?app_pk=<...>&job_id=<...>&day=<YYYY-MM-DD>`  

Réponse :  
```json
{
  "ok": true,
  "day": "2025-09-17",
  "job_id": "job_xxx",
  "top_positive_axes": [ ... ],
  "top_negative_axes": [ ... ]
}
```

---

#### 4. Programmer une analyse quotidienne
**PUT** `/themes/schedule`  
**GET** `/themes/schedule`  
**GET** `/themes/schedule/list`  

Permet de planifier une analyse journalière automatique. 

Exemple:

**PUT** `/themes/schedule?run-now=true`  
Request Body
```json
{ "app_pk":"android#com.fortuneo.android,ios#com.fortuneo.fortuneo", "appName":"Fortuneo", "interval_minutes":1440 }
```
Response Body
```json
{
    "ok": true,
    "schedule": {
        "app_pk": "android#com.fortuneo.android,ios#com.fortuneo.fortuneo",
        "due_pk": "DUE",
        "appName": "Fortuneo - la banque en ligne",
        "interval_minutes": 1440,
        "enabled": true,
        "last_enqueued_at": 0,
        "next_run_at": 1758240440949,
        "last_enqueued_at_iso": null,
        "next_run_at_iso": "2025-09-19T00:07:20.949Z"
    },
    "created": true,
    "run_now": {
        "ok": true,
        "job_id": "job_wpltxtmfonis9o",
        "day": "2025-09-18",
        "messageId": "02b1d32c-0b5d-4b8a-9d1b-4c245de40447"
    }
}
```

---

## 🗃️ Tables DynamoDB

| Table                   | PK         | SK         | Description |
|-------------------------|------------|------------|-------------|
| `revox_user_follows`    | `user_id`  | `app_pk`   | Liens user → apps suivies (+ fusions) |
| `apps_metadata`         | `app_pk`   | —          | Métadonnées apps |
| `revox_app_reviews`     | `app_pk`   | `ts_review`| Avis utilisateurs ingérés |
| `apps_ingest_schedule`  | `app_pk`   | `due_pk`   | Planning ingestion |
| `apps_themes`           | `app_pk`   | `sk`       | Analyses de thèmes (`pending#day#job`, `theme#day#job`) |
| `apps_themes_schedule`  | `app_pk`   | —          | Planning analyses de thèmes (quotidien) |
| `revox_users`           | `id`       | —          | Utilisateurs Cognito |

---

## 🔧 Variables d’environnement (extraits)

- `APP_REVIEWS_TABLE` = `revox_app_reviews`  
- `USER_FOLLOWS_TABLE` = `revox_user_follows`  
- `APPS_METADATA_TABLE` = `apps_metadata`  
- `APPS_INGEST_SCHEDULE_TABLE` = `apps_ingest_schedule`  
- `APPS_THEMES_TABLE` = `apps_themes`  
- `APPS_THEMES_SCHEDULE_TABLE` = `apps_themes_schedule`  
- `EXTRACTION_QUEUE_URL`, `THEMES_QUEUE_URL`, `AWS_REGION`, etc.  

---

## 🗓️ Dernière mise à jour
Septembre 2025
