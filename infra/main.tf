provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "aws_caller_identity" "current" {}

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

########################################
# SQS : file pour orchestrer les extractions
########################################
resource "aws_sqs_queue" "extraction_queue" {
  name                       = "revox-extraction-queue"
  visibility_timeout_seconds = 300    # 5 min pour traiter chaque message
  message_retention_seconds  = 86400  # conserve 24 h
}

# Output de l’URL pour pouvoir la consommer côté backend
output "extraction_queue_url" {
  description = "URL de la queue SQS pour les extractions"
  value       = aws_sqs_queue.extraction_queue.url
}

# Output de l’ARN si jamais utile
output "extraction_queue_arn" {
  description = "ARN de la queue SQS pour les extractions"
  value       = aws_sqs_queue.extraction_queue.arn
}

########################################
# API Gateway
########################################

# 1. API HTTP
resource "aws_apigatewayv2_api" "http_api" {
  name          = "revox-api"
  protocol_type = "HTTP"
}

# 2. Intégration unique vers ta Lambda
resource "aws_apigatewayv2_integration" "api_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = data.aws_lambda_function.api.arn
  payload_format_version = "1.0"
}

# 3. Les routes existantes
# GET /health
resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
}

# GET /dashboard
resource "aws_apigatewayv2_route" "dashboard" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /dashboard"
  target    = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
}

# ANY /{proxy+} (inclut POST /extract et toutes tes autres routes Express)
resource "aws_apigatewayv2_route" "proxy" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "ANY /{proxy+}"
  target    = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
}

# 4. Stage par défaut
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_logs.arn
    format = "{\"requestId\":\"$context.requestId\",\"routeKey\":\"$context.routeKey\",\"status\":\"$context.status\",\"error\":\"$context.error.message\"}"

  }
  default_route_settings {
    throttling_burst_limit   = 10000
    throttling_rate_limit    = 5000
    detailed_metrics_enabled = true
    logging_level = "INFO"
  }
}

# 5. Permission pour que API GW puisse invoquer Lambda
resource "aws_lambda_permission" "allow_apigw" {
  statement_id  = "b5f844c3-68f5-5e58-9c26-6f00925e94b2"
  action        = "lambda:InvokeFunction"
  function_name = data.aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

# 6. Permission pour que API GW puisse invoquer Lambda
output "http_api_endpoint" {
  description = "URL publique de l’HTTP API (stage $default)"
  value       = aws_apigatewayv2_api.http_api.api_endpoint
}

########################################
# Data source pour récupérer la Lambda Express existante
########################################
data "aws_lambda_function" "api" {
  function_name = "revox-backend"
}

########################################
# Function URL pour invoquer directement Lambda 
########################################
resource "aws_lambda_function_url" "api_url" {
  function_name      = data.aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

output "function_url" {
  description = "URL directe de la Lambda pour debug"
  value       = aws_lambda_function_url.api_url.function_url
}

########################################
# CloudWatch Log Group pour les logs d’API Gateway
########################################
resource "aws_cloudwatch_log_group" "apigw_logs" {
  name              = "/aws/http-api/${aws_apigatewayv2_api.http_api.name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_resource_policy" "apigw_logs" {
  policy_name = "APIGatewayAccessLogsPolicy"
  policy_document = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "apigateway.amazonaws.com"
        },
        Action = "logs:PutLogEvents",
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/http-api/revox-api:*"
      }
    ]
  })
}


