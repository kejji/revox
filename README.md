# Revox

🧠 Revox is a web application that extracts, analyzes, and leverages user feedback from public sources (e.g. app store reviews).  
It uses **AWS Cognito** for authentication, a **JWT-secured Express backend**, and a **React frontend with Amplify**.

---

## 🚀 Run the project locally

### 1. Clone the repository
git clone <your-repo-url>
cd revox

### 2. Provision Cognito with Terraform
cd infra
terraform init
terraform apply
➡️ Copy the cognito_user_pool_id and cognito_app_client_id values shown after apply.

### 3. Start the Express backend
cd backend
cp .env.example .env  # If the file doesn’t exist, create it
npm install
npm run dev

.env file:
COGNITO_USER_POOL_ID=<your_user_pool_id>
COGNITO_APP_CLIENT_ID=<your_app_client_id>

### 4. Start the React frontend
cd frontend
cp .env.example .env
npm install
npm run dev

.env file:
VITE_COGNITO_USER_POOL_ID=<your_user_pool_id>
VITE_COGNITO_APP_CLIENT_ID=<your_app_client_id>

## 🔐 Authentication

User sign-up and sign-in via AWS Cognito (with AWS Amplify)

Email confirmation via verification code

JWT token stored on client side

Backend /dashboard route is protected with JWT middleware

## 📁 Project structure

revox/
├── backend/       → Express backend (secured by JWT)
├── frontend/      → React + Amplify frontend
├── infra/         → Terraform files for AWS Cognito
└── README.md      → This file 😉