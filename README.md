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
➡️ Copy the `cognito_user_pool_id`, `cognito_app_client_id`, `extraction_queue_url`, and `results_bucket` values shown after apply.

---

### 3. Start the Express backend
```bash
cd backend
cp .env.example .env  # If the file doesn’t exist, create it
npm install
npm run dev
```

#### `.env` file (from `.env.example`)
```
AWS_REGION=eu-west-3                            # same as var.aws_region
COGNITO_USER_POOL_ID=<your_user_pool_id>        # terraform output cognito_user_pool_id
COGNITO_APP_CLIENT_ID=<your_app_client_id>      # terraform output cognito_app_client_id
EXTRACTION_QUEUE_URL=<sqs_url>                  # terraform output extraction_queue_url
EXTRACTIONS_TABLE=revox_extractions             # DynamoDB table name
RESULTS_BUCKET=<s3_bucket>                      # S3 bucket for CSV files
LOCAL=true                                      # start local Express server
```

---

### 4. Start the React frontend
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

#### `.env` file (from `.env.example`)
```
VITE_COGNITO_USER_POOL_ID=<your_user_pool_id>   # terraform output cognito_user_pool_id
VITE_COGNITO_APP_CLIENT_ID=<your_app_client_id> # terraform output cognito_app_client_id
VITE_API_URL=<backend_api_url>                  # or terraform output http_api_endpoint
```

### Extraction API

Send a `POST` request to `/extract` with the following JSON body:

```json
{
  "appName": "My App",
  "iosAppId": "123456789",
  "androidAppId": "com.example.app",
  "fromDate": "2024-01-01",
  "toDate": "2024-01-31"
}
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
├── infra/         → Terraform configuration (Cognito, API Gateway, DynamoDB, SQS)
└── README.md      → This file 😉
```

---

## 🗓️ Last updated

2025-07-08
