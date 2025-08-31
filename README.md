# 📱 Revox

**Revox** est une application web (SaaS) qui permet d’extraire, analyser et exploiter les avis utilisateurs des apps mobiles publiés sur les stores (App Store & Google Play).  
Elle s’adresse principalement aux équipes Produit, Marketing ou Business pour :
- suivre les avis utilisateurs dans le temps,
- détecter les incidents ou besoins récurrents,
- prioriser les développements à venir.

---

## 🧱 Architecture technique

- **Backend** : Node.js (Express) + JWT + API Gateway (HTTP API)  
- **Infra** : AWS (Lambda, DynamoDB, SQS, Cognito, Terraform)  
- **Frontend** : hébergé dans un autre repo (Lovable)

---

## 🚀 Démarrage local

### 1. Cloner le projet
```bash
git clone https://github.com/kejji/revox.git
cd revox
```

### 2. Provisionner l’infrastructure (Terraform)
```bash
cd infra
terraform init
terraform apply
```
📌 À la fin, note bien :
- `cognito_user_pool_id`
- `cognito_app_client_id`
- `extraction_queue_url`
- `http_api_endpoint`

---

### 3. Lancer le backend
```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

#### `.env` (extrait)
```env
AWS_REGION=eu-west-3
COGNITO_USER_POOL_ID=...
COGNITO_APP_CLIENT_ID=...
EXTRACTION_QUEUE_URL=...
EXTRACTIONS_TABLE=revox_extractions
LOCAL=true
```

---

## 🔐 Authentification

- Inscription / Connexion via **Cognito**  
- Email de vérification  
- Token JWT stocké côté client (géré par le frontend Lovable)  
- Les routes backend sont protégées par header `Authorization: Bearer <token>`

---

## 📘 API REST

Toutes les routes (sauf `/health` et `/search-app`) nécessitent un JWT valide.  

| Méthode | Route              | Description                            |
|--------:|--------------------|----------------------------------------|
| `GET`   | `/health`          | Vérifie l’état du backend              |
| `GET`   | `/search-app`      | Recherche d’apps par nom               |
| `POST`  | `/follow-app`      | Suivre une application                 |
| `DELETE`| `/follow-app`      | Ne plus suivre une application         |
| `GET`   | `/follow-app`      | Liste des apps suivies                 |
| `POST`  | `/reviews/ingest`  | Lancer une extraction des avis         |
| `GET`   | `/reviews`         | Lister les avis d’une application      |
| `GET`   | `/reviews/export`  | Exporter les avis au format CSV        |

📄 Voir [`revox_api_doc.md`](backend/revox_api_doc.md) pour le détail des payloads & réponses.

---

## 🗃️ Schéma des tables DynamoDB

| Table              | Partition key     | Sort key         | Description                          |
|-------------------|-------------------|------------------|--------------------------------------|
| `user_follows`     | `user_id`         | `app_pk`         | Lien user → apps suivies             |
| `apps_metadata`    | `app_key`         | —                | Cache nom + icône                    |
| `app_reviews`      | `app_pk`          | `ts_review`      | Avis utilisateurs                    |
| `RevoxUsers`       | `id`              | —                | Utilisateurs Cognito                 |

📄 Voir [`revox_dynamodb_doc.md`](infra/revox_dynamodb_doc.md) pour les schémas détaillés.

---

## 📁 Structure du projet

```
revox/
├── backend/       → Express + Lambda + SQS + API
│   └── revox_api_doc.md
├── infra/         → Terraform (Cognito, Gateway, DB, queues, IAM)
│   └── revox_dynamodb_doc.md
└── README.md      → Ce fichier 😉
```

---

## 🛠 Technologies principales

- **Express** (backend Node)  
- **Lambda** / **SQS** / **DynamoDB**  
- **Cognito** (auth)  
- **Terraform** (infra as code)  
- **GitHub Actions** (CI/CD pour le backend)  
- **Frontend** séparé, géré dans un autre repo via **Lovable**

---

## ⚙️ Configuration CORS

Les origines autorisées sont paramétrables via la variable Terraform `allowed_origins`.  
⚠️ Pense à inclure les URLs Lovable de ton frontend (préprod, preview, prod).  
Exemple :  
```hcl
allowed_origins = [
  "http://localhost:8080",
  "https://lovable.dev",
  "https://preview--<slug>.lovable.app",
  "https://<uuid>.lovableproject.com"
]
```

---

## 🗓️ Dernière mise à jour

📅 Septembre 2025
