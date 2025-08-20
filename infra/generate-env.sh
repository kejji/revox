#!/bin/bash
REPO="kejji/revox"
AWS_REGION="eu-west-3"
COGNITO_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
API_URL=$(terraform output -raw http_api_endpoint)

cat <<EOF > ../frontend/.env
AWS_REGION=$AWS_REGION
VITE_COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID
VITE_COGNITO_APP_CLIENT_ID=$COGNITO_APP_CLIENT_ID
VITE_API_URL=$API_URL
EOF

echo "✓ .env frontend generated in ../frontend/.env"

cat <<EOF > ../backend/.env
AWS_REGION=$AWS_REGION
COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID
COGNITO_APP_CLIENT_ID=$COGNITO_APP_CLIENT_ID
EXTRACTION_QUEUE_URL=$(terraform output -raw extraction_queue_url)
APP_REVIEWS_TABLE=$(terraform output -raw app_reviews_table_name)
USER_FOLLOWS_TABLE=$(terraform output -raw user_follows_table_name)
REVOX_USERS_TABLE=$(terraform output -raw revox_users_table_name)
APPS_METADATA_TABLE=$(terraform output -raw apps_metadata_table_name)
APPS_INGEST_SCHEDULE_TABLE=$(terraform output -raw apps_ingest_schedule_table_name)
EOF

echo "✓ .env backend generated in ../backend/.env"

gh secret set VITE_COGNITO_USER_POOL_ID -b"$COGNITO_USER_POOL_ID" --repo "$REPO"
gh secret set VITE_COGNITO_APP_CLIENT_ID -b"$COGNITO_APP_CLIENT_ID" --repo "$REPO"
gh secret set VITE_API_URL -b"$API_URL" --repo "$REPO"
