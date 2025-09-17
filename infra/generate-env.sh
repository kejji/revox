#!/bin/bash
REPO="kejji/revox"
AWS_REGION="eu-west-3"
COGNITO_USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
COGNITO_APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
API_URL=$(terraform output -raw http_api_endpoint)

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
APPS_THEMES_TABLE=$(terraform output -raw apps_themes_table_name)
THEMES_QUEUE_URL=$(terraform output -raw themes_queue_url)
OPENAI_SECRET_NAME=$(terraform output -raw openai_secret_name)
OPENAI_URL=$(terraform output -raw openai_url)
OPENAI_MODEL=$(terraform output -raw openai_model)
EOF

echo "✓ .env backend generated in ../backend/.env"