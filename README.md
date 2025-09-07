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

### Endpoints
- **POST** `/apps/merge`  
  Lie deux apps pour l’utilisateur courant.  
  **Body**
  ```json
  { "app_pks": ["android#com.fortuneo.android", "ios#com.fortuneo.fortuneo"] }
  ```
  **Réponse**
  ```json
  { "ok": true, "linked": { "android#com.fortuneo.android": ["ios#com.fortuneo.fortuneo"], "ios#com.fortuneo.fortuneo": ["android#com.fortuneo.android"] } }
  ```

- **DELETE** `/apps/merge`  
  Annule le lien précédemment créé.  
  **Body** identique au POST.

### Effets côté API existante
- **GET** `/follow-app` : chaque app suivie inclut désormais `linked_app_pks: string[]`.
- **GET** `/reviews` : accepte **un seul paramètre `app_pk`** pouvant contenir **une valeur** ou **plusieurs séparées par des virgules** → les avis sont fusionnés et triés par date (DESC par défaut).
  - Ex. mono : `app_pk=android%23com.fortuneo.android`
  - Ex. multi : `app_pk=android%23com.fortuneo.android,ios%23310633997`
  - ⚠️ URL encoder `#` → `%23`.
- **GET** `/reviews/export` : export CSV multi-apps et **couverture complète de la plage** `from`/`to`. Il **n’y a plus de paramètre `limit` exposé** ; la pagination DynamoDB est interne.

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

### 🧷 Fusion d’applications (nouveau)
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

### ⏱️ Programmer l’ingestion
**PUT** `/ingest/schedule`  
**GET** `/ingest/schedule`  
**GET** `/ingest/schedule/list`

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
