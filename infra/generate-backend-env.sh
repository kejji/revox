#!/bin/bash
echo "Génération du .env pour le backend..."

cat <<EOF > ../backend/.env
AWS_REGION=eu-west-3
COGNITO_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
SQS_QUEUE_URL=$(terraform output -raw extraction_queue_url)
DYNAMODB_TABLE_NAME=$(terraform output -raw extractions_table_name)
EOF

echo ".env backend généré dans ../backend/.env"
