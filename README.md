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
- Joindre le JWT dans chaque requête protégée :
```
Authorization: Bearer <JWT_TOKEN>
```

---

## 📘 API

> **Toutes** les routes ci‑dessous (hors `/health` et `/search-app`) requièrent un JWT.

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
**Description** : Permet de rechercher une app sur les stores iOS et Android à partir d’un mot-clé.  

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
**Description** : Associe l’app à l’utilisateur et déclenche automatiquement un job de planification (`PUT /ingest/schedule`). Idempotent : si l’app est déjà suivie, la réponse indique `already: true`.  

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
**Description** : Supprime le lien entre l’utilisateur et une app, sans supprimer les données existantes.  

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
**Description** : Retourne toutes les apps suivies par l’utilisateur, enrichies avec nom et icône.  

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
**Description** : Déclenche manuellement l’ingestion des avis d’une app. Peut être utilisé pour forcer un backfill sur une période donnée.  

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
**Description** : Récupère les avis stockés en base pour une app donnée. Supporte la **pagination avec curseur** : la réponse contient `nextCursor` qu’il faut réutiliser comme paramètre `cursor` dans l’appel suivant pour obtenir la page suivante.  

**Query params** :  
| Paramètre   | Type             | Requis | Exemple |
|-------------|------------------|--------|---------|
| `platform`  | `ios`\|`android` | ✅      | `android` |
| `bundleId`  | string           | ✅      | `com.fortuneo.android` |
| `limit`     | number           | optionnel | `50` |
| `from` / `to` | ISO date       | optionnel | `2025-08-01T00:00:00Z` |
| `order`     | `asc`\|`desc`    | optionnel | `desc` |
| `cursor`    | string (opaque)  | optionnel | jeton renvoyé par l’appel précédent |

**Exemple de réponse** :  
```json
{
  "items": [
    {
      "app_pk": "android#com.fortuneo.android",
      "date": "2025-09-02T08:24:45.612Z",
      "rating": 5,
      "platform": "android",
      "ts_review": "2025-09-02T08:24:45.612Z#5wbata",
      "app_name": "Fortuneo - la banque en ligne",
      "ingested_at": "2025-09-03T08:46:10.193Z",
      "app_version": "10.20.0",
      "text": "superbe banque 👍",
      "source": "store-scraper-v1",
      "user_name": "Maurice jean Claude Airaudo",
      "bundle_id": "com.fortuneo.android"
    }
  ],
  "nextCursor": "eyJhcHBfcGsiOiJhbmRyb2lkI2NvbS5mb3J0dW5lby5hbmRyb2lkIiwidHNfcmV2aWV3IjoiMjAyNS0wOS0wMVQwOToxOTowNS41ODBaIzFmcGpnMm4ifQ==",
  "count": 5
}
```

---

### 📤 Export CSV des avis
**GET** `/reviews/export`  
**Description** : Identique à `/reviews`, mais retourne un fichier CSV. Pratique pour exploitation externe (Excel, BI).  

---

### ⏱️ Programmer l’ingestion
**PUT** `/ingest/schedule`  
**Description** : Crée ou met à jour un job d’ingestion récurrent pour une app suivie. Intervalle en minutes configurable.  

**Body (JSON)**
```json
{ "bundleId": "com.instagram.android", "platform": "android", "intervalMinutes": 30 }
```

---

### 📊 Consulter la planification d’une app
**GET** `/ingest/schedule`  
**Description** : Retourne la configuration d’ingestion planifiée pour une app spécifique (interval, last run, next run).  

| Paramètre | Type | Requis | Exemple |
|---|---|---|---|
| `bundleId` | string | ✅ | `com.instagram.android` |
| `platform` | `ios`\|`android` | ✅ | `android` |

---

### 📋 Lister tous les jobs planifiés
**GET** `/ingest/schedule/list`  
**Description** : Liste l’ensemble des jobs d’ingestion planifiés pour l’utilisateur. Supporte un paramètre `limit`.  

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

## 🗃️ Tables DynamoDB

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
