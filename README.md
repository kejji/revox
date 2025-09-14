# 📱 Revox — Backend (API + BDD)

**Revox** est un **backend** qui extrait et analyse les avis utilisateurs des apps mobiles (App Store & Google Play).  
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
- Joindre le JWT dans chaque requête protégée :
```
Authorization: Bearer <JWT_TOKEN>
```

---

## 📘 API

> **Toutes** les routes ci-dessous (hors `/health` et `/search-app`) requièrent un JWT.

### 🟢 Health
**GET** `/health`  
**Description** : Vérifie que l’API est en ligne et opérationnelle. Utile pour les sondes de monitoring.  

Réponse :
```json
{ "status": "OK" }
```

---

### 🔎 Recherche d’apps
**GET** `/search-app`  
**Description** : Rechercher une app sur les stores iOS et Android à partir d’un mot-clé.  

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
**Description** : Lie l’app à l’utilisateur et planifie automatiquement l’ingestion (`PUT /ingest/schedule`). Idempotent.  

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android" }
```

**Réponse**
```json
{
  "ok": true,
  "followed": { "bundleId": "com.instagram.android", "platform": "android", "followedAt": "2025-09-01T12:34:56Z" },
  "schedule": { "created": true, "already": false }
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
**Description** : Retourne toutes les apps suivies par l’utilisateur, enrichies avec nom, icône et liens éventuels.  

**Réponse**
```json
{
  "followed": [
    {
      "bundleId":"com.instagram.android",
      "platform":"android",
      "name":"Instagram",
      "icon":"https://...",
      "linked_app_pks": ["ios#com.fortuneo.fortuneo"]
    }
  ]
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

**Réponses** : incluent l’état `linked` après opération.

---

### 🗂 Lancer une ingestion d’avis
**POST** `/reviews/ingest`  
**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android", "appName": "Instagram", "backfillDays": 2 }
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

### 🧑‍🔬 Analyse de thèmes
**GET** `/reviews/themes`  
**Description** : Analyse les avis et en extrait automatiquement des **axes thématiques** (positifs et négatifs).  
Basé sur un modèle IA (OpenAI), avec déduplication et fusion de synonymes.  
Renvoie les **top 3 négatifs** et **top 3 positifs**, plus un breakdown complet par axe.

**Query params** :  
| Paramètre   | Type                 | Requis | Exemple |
|-------------|----------------------|--------|---------|
| `app_pk`    | string (mono **ou** multi, séparé par virgules) | ✅ | `android%23com.fortuneo.android,ios%23com.fortuneo.fortuneo` |
| `from` / `to` | ISO date | optionnel | `2025-08-01T00:00:00.000Z` / `2025-09-01T23:59:59.999Z` |
| `count`     | number | optionnel (exclusif avec `from/to`) | `200` |
| `pos_cutoff`| number (0..5, défaut 4) | optionnel | `4` |
| `neg_cutoff`| number (0..5, défaut 3) | optionnel | `3` |
| `topn`      | number (1..5, défaut 3) | optionnel | `3` |
| `include_breakdown` | 0/1 | optionnel | `1` |

**Exemple 1 — par période**
```http
GET /reviews/themes?app_pk=android%23com.fortuneo.android&from=2025-08-01T00:00:00.000Z&to=2025-09-01T23:59:59.999Z
```

**Exemple 2 — par nombre d’avis récents**
```http
GET /reviews/themes?app_pk=android%23com.fortuneo.android&count=200
```

**Exemple réponse**
```json
{
  "ok": true,
  "params": {
    "app_pks": ["android#com.fortuneo.android"],
    "from": "2025-08-01T00:00:00.000Z",
    "to": "2025-09-01T23:59:59.999Z",
    "count": 200,
    "total_reviews": 200,
    "pos_cutoff": 4,
    "neg_cutoff": 3,
    "model": "gpt-4o-mini"
  },
  "top_negative_axes": [
    {
      "axis_id":"service_client",
      "axis_label":"Service client / Réactivité",
      "count":12,
      "avg_rating":1.2,
      "examples":[ ... ]
    }
  ],
  "top_positive_axes": [
    {
      "axis_id":"ergonomie",
      "axis_label":"Ergonomie / Simplicité",
      "count":8,
      "avg_rating":4.6,
      "examples":[ ... ]
    }
  ],
  "axes": [ ... ]
}
```
---

### ⏱️ Programmer l’ingestion
**PUT** `/ingest/schedule`  
**GET** `/ingest/schedule`  
**GET** `/ingest/schedule/list`

---

**Exemple 1 — par période**
```http
GET /reviews/themes?app_pk=android%23com.fortuneo.android&from=2025-08-01T00:00:00.000Z&to=2025-09-01T23:59:59.999Z
```

**Exemple 2 — par nombre d’avis récents**
```http
GET /reviews/themes?app_pk=android%23com.fortuneo.android&count=200
```

**Exemple réponse**
```json
{
  "ok": true,
  "top_negative_axes": [
    { "axis_id":"card_issues","axis_label":"Carte / Blocages","count":26,"avg_rating":1.69,"examples":[ ... ] },
    { "axis_id":"customer_support","axis_label":"Service client","count":15,"avg_rating":1.47,"examples":[ ... ] }
  ],
  "top_positive_axes": [
    { "axis_id":"fees_pricing","axis_label":"Tarifs / Frais","count":3,"avg_rating":4.67,"examples":[ ... ] }
  ],
  "axes": [ ... ]
}
```

---

## 🗃️ Tables DynamoDB

| Table                 | PK            | SK         | Description                          |
|---|---|---|---|
| `revox_user_follows`  | `user_id`     | `app_pk`   | Lien user → apps suivies (+ item `APP_LINKS` pour fusions) |
| `apps_metadata`       | `app_pk`      | —          | Nom, icône, store ids…               |
| `revox_app_reviews`   | `app_pk`      | `ts_review`| Avis utilisateurs ingérés            |
| `revox_users`         | `id`          | —          | Utilisateurs Cognito                 |
| `apps_ingest_schedule`| `app_pk`      | `due_pk`   | Planification des jobs d’ingestion   |

---

## 🔧 Variables d’environnement (extraits)

- `USER_FOLLOWS_TABLE` = `revox_user_follows`
- `APPS_METADATA_TABLE` = `apps_metadata`
- `APPS_INGEST_SCHEDULE_TABLE` = `apps_ingest_schedule`
- `REVIEWS_TABLE` = `revox_app_reviews`
- `EXTRACTION_QUEUE_URL` (SQS), `AWS_REGION`, etc.

---

## 🔒 IAM (extraits requis côté Lambda `api`)

- Sur `revox_user_follows` : `GetItem`, `PutItem`, `UpdateItem`, `Query`
- Sur `apps_metadata` : `GetItem`, `PutItem`
- Sur `revox_app_reviews` : `Query`
- Sur `apps_ingest_schedule` : `GetItem`, `PutItem`, `UpdateItem`, `Query`

---

## 🗓️ Dernière mise à jour
Septembre 2025
