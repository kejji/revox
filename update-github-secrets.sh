#!/bin/bash

# 💡 Ce script suppose que tu as Terraform initialisé ET que tu es authentifié avec la CLI GitHub (gh auth login)

REPO="ton-username/ton-repo"  # 👉 À adapter avec ton repo GitHub

echo "🔄 Récupération des outputs Terraform..."

USER_POOL_ID=$(terraform output -raw cognito_user_pool_id)
APP_CLIENT_ID=$(terraform output -raw cognito_app_client_id)
API_URL=$(terraform output -raw api_url)

echo "🔐 Mise à jour des secrets GitHub pour $REPO"

gh secret set VITE_COGNITO_USER_POOL_ID -b"$USER_POOL_ID" --repo "$REPO"
gh secret set VITE_COGNITO_APP_CLIENT_ID -b"$APP_CLIENT_ID" --repo "$REPO"
gh secret set VITE_API_URL -b"$API_URL" --repo "$REPO"

echo "✅ Secrets mis à jour avec succès."

