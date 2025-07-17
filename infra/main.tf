provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

data "aws_caller_identity" "current" {}

# Bootstrap : DynamoDB Table pour le lock du tfstate et S3 Bucket pour stocker le tfstate
resource "aws_s3_bucket" "tf_state" {
  bucket = "revox-terraform-state"

  tags = {
    Name = "Terraform State Bucket"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_dynamodb_table" "tf_locks" {
  name         = "revox-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = {
    Name = "Terraform Lock Table"
  }
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

########################################
# Athorizer Cognito
########################################
resource "aws_apigatewayv2_authorizer" "cognito_authorizer" {
  name                       = "revox-cognito-authorizer"
  api_id                     = aws_apigatewayv2_api.http_api.id
  authorizer_type            = "JWT"
  identity_sources           = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.revox_app_client.id]
    issuer   = "https://${aws_cognito_user_pool.revox_user_pool.endpoint}"
  }
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
  name = "revox_extractions"
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
    name = "status-createdAt-index"
    hash_key = "status"
    range_key = "created_at"
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
  name = "revox-extraction-queue"
  visibility_timeout_seconds = 300    # 5 min pour traiter chaque message
  message_retention_seconds  = 86400  # conserve 24 h
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
  integration_uri        = aws_lambda_function.api.arn
  payload_format_version = "2.0"
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
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "GET /dashboard"
  target             = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

# POST /extract
resource "aws_apigatewayv2_route" "extract" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "POST /extract"
  target             = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_authorizer.id
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
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

########################################
# Function URL pour invoquer directement Lambda 
########################################
resource "aws_lambda_function_url" "api_url" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}


########################################
#  Ressource gérant la Lambda Express
########################################
resource "aws_lambda_function" "api" {
  function_name    = "revox-backend"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "index.handler"
  runtime          = "nodejs18.x"
  filename         = "${path.module}/dummy.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")
  kms_key_arn = aws_kms_key.lambda_env.arn
  environment {
    variables = {
      EXTRACTIONS_TABLE    = aws_dynamodb_table.extractions.name
      EXTRACTION_QUEUE_URL = aws_sqs_queue.extraction_queue.url
    }
  }
  # Indique un ZIP (mêmes champs qu'avant, mais pointant sur le dummy)
  lifecycle {
    # Ignore tout changement de code : c'est GitHub Actions qui push réellement
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

########################################
#  Ressource gérant la lambda worker
########################################
resource "aws_lambda_function" "worker" {
  function_name = "revox-worker"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "worker.handler"
  runtime       = "nodejs18.x"
  filename      = "${path.module}/dummy.zip" # remplace plus tard par un vrai zip
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")

  environment {
    variables = {
      EXTRACTIONS_TABLE = aws_dynamodb_table.extractions.name
      S3_BUCKET = aws_s3_bucket.csv_bucket.bucket    
    }
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

# Liaison SQS -> Lambda worker
resource "aws_lambda_event_source_mapping" "worker_sqs" {
  event_source_arn  = aws_sqs_queue.extraction_queue.arn
  function_name     = aws_lambda_function.worker.arn
  batch_size        = 1
}

#######################################
# Bucket S3 for csv extractions
########################################
resource "aws_s3_bucket" "csv_bucket" {
  bucket = "revox-csv"

  tags = {
    Name = "Bucket CSV pour Revox"
  }
}


########################################
# CloudWatch Log Group pour les logs Lambda
########################################
resource "aws_cloudwatch_log_group" "lambda_log_group" {
  name              = "/aws/lambda/${aws_lambda_function.api.function_name}"
  retention_in_days = 14
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

########################################
# IAM pour la Lambda "revox-backend"
########################################
resource "aws_iam_role" "lambda_exec" {
  name = "revox-backend-exec-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Permission d’écrire les logs CloudWatch
resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Permission DynamoDB
resource "aws_iam_role_policy_attachment" "lambda_dynamodb" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
}

# Permission SQS
resource "aws_iam_role_policy_attachment" "lambda_sqs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSQSFullAccess"
}

# Permission S3
resource "aws_iam_role_policy_attachment" "lambda_s3" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3FullAccess"
}

# Clé KMS pour chiffrer les variables d'environnement Lambda
resource "aws_kms_key" "lambda_env" {
  description             = "Clé KMS pour les variables d’environnement Lambda"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

# Policy KMS autorisant le rôle Lambda à déchiffrer les variables
resource "aws_kms_key_policy" "lambda_env_policy" {
  key_id = aws_kms_key.lambda_env.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid: "Allow Lambda Execution Role to decrypt",
        Effect: "Allow",
        Principal = {
          AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/revox-backend-exec-role"
        },
        Action = [
          "kms:Decrypt",
          "kms:Encrypt",
          "kms:GenerateDataKey*"
        ],
        Resource = "*"
      },
      {
        Sid: "EnableIAMUserPermissions",
        Effect: "Allow",
        Principal: {
          AWS: "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        },
        Action: "kms:*",
        Resource: "*"
      }
    ]
  })
}




