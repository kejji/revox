provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

# 1. Création du User Pool
resource "aws_cognito_user_pool" "revox_user_pool" {
  name = "revox-user-pool"

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }

  auto_verified_attributes = ["email"]
}

# 2. Création du client web (sans secret)
resource "aws_cognito_user_pool_client" "revox_app_client" {
  name            = "revox-web-client"
  user_pool_id    = aws_cognito_user_pool.revox_user_pool.id
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  callback_urls = ["http://localhost:3000/"]
  logout_urls   = ["http://localhost:3000/"]
}

# 3. Outputs pour Cognito
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.revox_user_pool.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.revox_app_client.id
}

########################################
# DynamoDB: table des utilisateurs
########################################
resource "aws_dynamodb_table" "users" {
  name         = "revox_users"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }

  # TTL (optionnel)
  # ttl {
  #   attribute_name = "ttl"
  #   enabled        = false
  # }
}

########################################
# DynamoDB: table des extractions CSV
########################################
resource "aws_dynamodb_table" "extractions" {
  name         = "revox_extractions"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "user_id"
  range_key = "extraction_id"

  # Définition des attributs (au niveau racine)
  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "extraction_id"
    type = "S"
  }
  attribute {
    name = "status"
    type = "S"
  }
  attribute {
    name = "created_at"
    type = "S"
  }

  # GSI pour requêtes par status + date
  global_secondary_index {
    name            = "status-createdAt-index"
    hash_key        = "status"
    range_key       = "created_at"
    projection_type = "ALL"
  }

  # Les autres attributs (app_name, from_date, to_date,
  # s3_key, status, created_at, updated_at, error_message)
  # seront stockés automatiquement.
}
