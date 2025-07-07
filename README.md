# Revox

🧠 Revox is a web app that extracts, analyzes, and leverages user feedback from public sources (e.g. app store reviews).  
It uses **AWS Cognito** for authentication, a **JWT-secured Express backend**, and a **React frontend with Amplify**.

---

## 🚀 Run the project locally

### 1. Clone the repository
```bash
git clone <your-repo-url>
cd revox
```

### 2. Provision Cognito with Terraform
```bash
cd infra
terraform init
terraform apply
```
➡️ Copy the `cognito_user_pool_id` and `cognito_app_client_id` values shown after apply.

### 3. Build the migration Lambda
```bash
cd infra
./build_migration_zip.sh
```
This script produces `migration.zip` from the contents of `infra/migration`.

---

### 4. Start the Express backend
```bash
cd backend
cp .env.example .env  # If the file doesn’t exist, create it
npm install
npm run dev
```

#### `.env` file:
```
COGNITO_USER_POOL_ID=<your_user_pool_id>
COGNITO_APP_CLIENT_ID=<your_app_client_id>
```

---

### 5. Start the React frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

#### `.env` file:
```
VITE_COGNITO_USER_POOL_ID=<your_user_pool_id>
VITE_COGNITO_APP_CLIENT_ID=<your_app_client_id>
```

---

## 🔐 Authentication

- Sign-up / Sign-in via AWS Cognito (with Amplify)
- Email confirmation via verification code
- JWT token stored on the client
- Backend `/dashboard` route is protected using JWT

---

## 📁 Project structure

```
revox/
├── backend/       → Express backend (JWT-protected)
├── frontend/      → React + Amplify frontend
├── infra/         → Terraform configuration (Cognito)
│   └── migration/ → Lambda for database migrations
└── README.md      → This file 😉
```

---

## 🗓️ Last updated

2025-07-07
