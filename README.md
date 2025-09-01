# 📱 Revox — Backend

**Revox** est le **backend** d’une application SaaS permettant d’extraire, analyser et exploiter les avis utilisateurs des apps mobiles publiés sur les stores (App Store & Google Play).  
Il fournit une **API REST sécurisée** consommée par un frontend externe (hébergé sur Lovable).

Ce backend s’adresse principalement aux équipes Produit, Marketing ou Business pour :
- suivre les avis utilisateurs dans le temps,
- détecter les incidents ou besoins récurrents,
- prioriser les développements à venir.

---

## 🧱 Architecture technique

- **Backend** : Node.js (Express) + JWT + API Gateway (HTTP API)  
- **Infra** : AWS (Lambda, DynamoDB, SQS, Cognito, Terraform)  
- **Frontend** : séparé, dans un autre repo (Lovable)

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

### 3. Lancer le backend en local
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

- Authentification via **Cognito**  
- Email de vérification et gestion des utilisateurs côté Cognito  
- Token JWT à inclure dans l’en-tête `Authorization: Bearer <token>` pour appeler les routes protégées  
- Le frontend (Lovable) gère la session utilisateur et envoie le JWT aux appels API

---

## 📘 API REST

Toutes les routes (sauf `/health` et `/search-app`) nécessitent un JWT valide.

| Méthode | Route                      | Description                                             |
|--------:|----------------------------|---------------------------------------------------------|
| `GET`   | `/health`                  | Vérifie l’état du backend                               |
| `GET`   | `/search-app`              | Recherche d’apps par nom                                |
| `POST`  | `/follow-app`              | Suivre une application                                  |
| `DELETE`| `/follow-app`              | Ne plus suivre une application                          |
| `GET`   | `/follow-app`              | Liste des apps suivies                                  |
| `POST`  | `/reviews/ingest`          | Lancer une extraction des avis                          |
| `GET`   | `/reviews`                 | Lister les avis d’une application                       |
| `GET`   | `/reviews/export`          | Exporter les avis au format CSV                         |
| `PUT`   | `/ingest/schedule`         | Planifier / mettre à jour le job d’ingestion d’une app  |
| `GET`   | `/ingest/schedule`         | Récupérer l’état/planification d’une app suivie         |
| `GET`   | `/ingest/schedule/list`    | Lister **tous** les jobs d’ingestion planifiés          |

> Détails des payloads/params dans [`backend/revox_api_doc.md`](backend/revox_api_doc.md).  
> Les endpoints `ingest/schedule*` s’appuient sur une Lambda **ingestScheduler** + EventBridge.

---

## 🗃️ Schéma des tables DynamoDB

Les tables ci-dessous sont provisionnées par Terraform.

| Table                    | Partition key (`PK`) | Sort key (`SK`) | Description |
|--------------------------|----------------------|-----------------|-------------|
| `revox_users`            | `id`                 | —               | Utilisateurs (métadonnées côté backend pour Cognito) |
| `revox_user_follows`     | `user_id`            | `app_pk`        | Lien utilisateur → applications suivies |
| `apps_metadata`          | `app_pk`             | —               | Métadonnées d’app (nom, icône, store ids…) |
| `revox_app_reviews`      | `app_pk`             | `ts_review`     | Avis utilisateurs ingérés (triés par timestamp) |
| `apps_ingest_schedule`   | `app_pk`             | `next_run_at`   | Planification des jobs d’ingestion par app |
| `revox-terraform-locks`* | `LockID`             | —               | (Interne Terraform) table de lock du state |

\* Table interne à Terraform, **ne pas** l’utiliser dans l’application.

---

## 📁 Structure du projet

```
revox/
├── backend/       → Express + Lambda + API
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
- **GitHub Actions** (CI/CD backend)  
- **Frontend** séparé, développé et maintenu via **Lovable**

---

## ⚙️ Configuration CORS

Les origines autorisées sont paramétrables via la variable Terraform `allowed_origins`.  
⚠️ Inclure les URLs Lovable du frontend (préprod, preview, prod).

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
