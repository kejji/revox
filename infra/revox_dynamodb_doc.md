# 🗃️ Revox – Schéma des bases de données DynamoDB

---

## 📌 1. Table : `user_follows`

### ✅ Description
Stocke les relations entre utilisateurs et applications suivies.

### 🔑 Clés
- **Partition key** : `user_id` (string)
- **Sort key** : `app_pk` (string) → format : `bundleId#platform`

### 🧱 Exemple d’item
```json
{
  "user_id": "user-123",
  "app_pk": "com.instagram.android#android",
  "followed_at": "2025-08-13T12:34:56Z"
}
```

### 💡 Notes
- Chaque app suivie est enregistrée comme un item unique.
- Un utilisateur peut suivre la même app sur plusieurs plateformes.

---

## 📌 2. Table : `apps_metadata`

### ✅ Description
Cache partagé des métadonnées d'apps (nom, icône, etc.) pour enrichir le dashboard.

### 🔑 Clé
- **Partition key** : `app_key` (string) → format : `bundleId#platform`

### 🧱 Exemple d’item
```json
{
  "app_key": "com.instagram.android#android",
  "name": "Instagram",
  "icon": "https://play-lh.googleusercontent.com/...",
  "platform": "android",
  "bundleId": "com.instagram.android",
  "lastUpdated": "2025-08-13T13:00:00Z"
}
```

### 💡 Notes
- Remplie automatiquement quand un utilisateur suit une app.
- Permet d’éviter des appels vers l’App Store ou Play Store côté frontend.

---

## 📌 3. Table : `app_reviews`

### ✅ Description
Contient tous les avis utilisateurs collectés par scraping depuis les stores.

### 🔑 Clés
- **Partition key** : `app_pk` (string) → `platform#bundleId`
- **Sort key** : `ts_review` (string) → format : `date#<hash>`

### 🧱 Exemple d’item
```json
{
  "app_pk": "android#com.instagram.android",
  "ts_review": "2025-08-13T00:00:00.000Z#abc123",
  "date": "2025-08-13T00:00:00.000Z",
  "rating": 4,
  "text": "Great app!",
  "user_name": "Anonymous",
  "app_version": "298.0.0",
  "platform": "android",
  "app_name": "Instagram",
  "bundle_id": "com.instagram.android",
  "ingested_at": "2025-08-13T01:00:00Z",
  "source": "store-scraper-v1"
}
```

### 💡 Notes
- Ingestion faite via Lambda `worker` depuis SQS.
- Les reviews sont stockées de façon idempotente (grâce à `ts_review` unique par date+texte+user).

---

## 📌 4. Table : `RevoxUsers` (liée à Cognito)

### ✅ Description
Contient les infos de base des utilisateurs créés via Cognito.

### 🔑 Clé
- **Partition key** : `id` (string) → correspond à `sub` de Cognito

### 🧱 Exemple d’item
```json
{
  "id": "user-123",
  "email": "user@example.com",
  "family_name": "Kejji",
  "given_name": "Slimane",
  "created_at": "2025-08-01T10:00:00Z",
  "plan": "free",
  "status": "active"
}
```

---

## 🧾 Résumé visuel

| Table              | Partition key     | Sort key         | But principal                        |
|-------------------|-------------------|------------------|--------------------------------------|
| `user_follows`     | `user_id`         | `app_pk`         | Lien user → apps suivies             |
| `apps_metadata`    | `app_key`         | —                | Cache nom + icône                    |
| `app_reviews`      | `app_pk`          | `ts_review`      | Reviews utilisateurs par app         |
| `RevoxUsers`       | `id`              | —                | Infos utilisateurs Cognito           |

