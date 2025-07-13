#!/bin/bash
echo "Génération du .env pour le frontend..."

cat <<EOF > ../frontend/.env
VITE_REGION=eu-west-3
VITE_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
VITE_APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
VITE_API_URL=$(terraform output -raw http_api_endpoint)
EOF

echo ".env frontend généré dans ../frontend/.env"
