provider "aws" {
  region = "eu-west-3"
  profile = "revox-dev"
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
  name               = "revox-web-client"
  user_pool_id       = aws_cognito_user_pool.revox_user_pool.id
  generate_secret    = false

  explicit_auth_flows = [
    "ALLOW_USER_PASSWORD_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  callback_urls = ["http://localhost:3000/"]
  logout_urls   = ["http://localhost:3000/"]
}

# 3. Outputs pour tes apps
output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.revox_user_pool.id
}

output "cognito_app_client_id" {
  value = aws_cognito_user_pool_client.revox_app_client.id
}

