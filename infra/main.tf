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

  lambda_config {
    post_confirmation = aws_lambda_function.user_sync.arn
  }

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

# 3. Autoriser Cognito à invoquer la Lambda
resource "aws_lambda_permission" "allow_cognito_postconf" {
  statement_id  = "AllowExecutionFromCognitoPostConfirmation"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.user_sync.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.revox_user_pool.arn
}

########################################
# Athorizer Cognito
########################################
resource "aws_apigatewayv2_authorizer" "cognito_authorizer" {
  name             = "revox-cognito-authorizer"
  api_id           = aws_apigatewayv2_api.http_api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  jwt_configuration {
    audience = [aws_cognito_user_pool_client.revox_app_client.id]
    issuer   = "https://${aws_cognito_user_pool.revox_user_pool.endpoint}"
  }
}


########################################
# Table DynamoDB: table des utilisateurs
########################################
resource "aws_dynamodb_table" "users" {
  name         = "revox_users"
  billing_mode = "PAY_PER_REQUEST"

  hash_key = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

########################################
# Table DynamoDB : APP_REVIEWS
########################################
resource "aws_dynamodb_table" "app_reviews" {
  name         = "revox_app_reviews"
  billing_mode = "PAY_PER_REQUEST"

  hash_key  = "app_pk"
  range_key = "ts_review"

  attribute {
    name = "app_pk"
    type = "S"
  }
  attribute {
    name = "ts_review"
    type = "S"
  }

  tags = {
    Name = "Revox App Reviews"
  }
}

########################################
# Table DynamoDB : USER_FOLLOWS
########################################

resource "aws_dynamodb_table" "user_follows" {
  name         = "revox_user_follows"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "app_pk"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "app_pk"
    type = "S"
  }

  # (Optionnel) GSI pour compter les followers par app
  global_secondary_index {
    name            = "GSI1"
    hash_key        = "app_pk"
    range_key       = "user_id"
    projection_type = "ALL"
  }

  tags = {
    Name = "Revox User Follows"
  }
}

########################################
# Table DynamoDB : APPS_METADATA
########################################


resource "aws_dynamodb_table" "apps_metadata" {
  name         = "apps_metadata"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "app_pk"

  attribute {
    name = "app_pk"
    type = "S"
  }

   tags = {
    Name = "Revox Apps Metadata"
  }
}

########################################
# Table DynamoDB : APPS_INGEST_SCHEDULE
########################################


resource "aws_dynamodb_table" "apps_ingest_schedule" {
  name         = "apps_ingest_schedule"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "app_pk"

  attribute { 
    name = "app_pk"
    type = "S" 
  }

  attribute { 
    name = "due_pk"
    type = "S" 
  }

  attribute { 
    name = "next_run_at"
    type = "N" 
  }
  
  global_secondary_index {
    name               = "gsi_due"
    hash_key           = "due_pk"
    range_key          = "next_run_at"
    projection_type    = "ALL"
  }

  tags = {
    Name = "Revox Apps Ingest Schedule"
  }
}

########################################
# SQS : file pour orchestrer les extractions
########################################
resource "aws_sqs_queue" "extraction_queue" {
  name                       = "revox-extraction-queue"
  visibility_timeout_seconds = 300   # 5 min pour traiter chaque message
  message_retention_seconds  = 86400 # conserve 24 h
}

# Liaison SQS -> Lambda worker
resource "aws_lambda_event_source_mapping" "worker_sqs" {
  event_source_arn = aws_sqs_queue.extraction_queue.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 1
}

########################################
# API Gateway
########################################

# 1. API HTTP
resource "aws_apigatewayv2_api" "http_api" {
  name          = "revox-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = ["http://localhost:8080", 
                      "https://lovable.dev", 
                      "https://preview--revox-frontend.lovable.app", 
                      "https://lovable.app", 
                      "https://c9a1ce22-5aa0-4154-9698-a80bfd723859.lovableproject.com",
                      "https://id-preview--c9a1ce22-5aa0-4154-9698-a80bfd723859.lovable.app",
                      "https://c9a1ce22-5aa0-4154-9698-a80bfd723859.sandbox.lovable.dev"
                    ]
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["Authorization", "Content-Type"]
    max_age       = 600
  }
}

# 2. Intégration unique vers ta Lambda
resource "aws_apigatewayv2_integration" "api_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.arn
  payload_format_version = "2.0"
}

# 3. Public: GET /health
resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.http_api.id
  route_key = "GET /health"
  target    = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  # SANS authorization_type -> public
}

# 4. Protégé: ANY /  (la racine "/")
resource "aws_apigatewayv2_route" "root" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "ANY /"
  target             = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

# 5. Protégé: ANY /{proxy+}  (tout le reste)
resource "aws_apigatewayv2_route" "proxy" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "ANY /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito_authorizer.id
}

# 6. Route OPTIONS catch-all (préflight) — PAS d’auth
resource "aws_apigatewayv2_route" "options_proxy" {
  api_id             = aws_apigatewayv2_api.http_api.id
  route_key          = "OPTIONS /{proxy+}"
  target             = "integrations/${aws_apigatewayv2_integration.api_integration.id}"
  authorization_type = "NONE"
}

# 7. Stage par défaut
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigw_logs.arn
    format          = "{\"requestId\":\"$context.requestId\",\"routeKey\":\"$context.routeKey\",\"status\":\"$context.status\",\"error\":\"$context.error.message\"}"

  }
  default_route_settings {
    throttling_burst_limit   = 10000
    throttling_rate_limit    = 5000
    detailed_metrics_enabled = true
    logging_level            = "INFO"
  }
}

# 8. Permission pour que API GW puisse invoquer Lambda
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
  timeout          = 10
  filename         = "${path.module}/dummy.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")
  kms_key_arn      = aws_kms_key.lambda_env.arn
  environment {
    variables = {
      APP_REVIEWS_TABLE               = aws_dynamodb_table.app_reviews.name
      EXTRACTION_QUEUE_URL            = aws_sqs_queue.extraction_queue.url
      USER_FOLLOWS_TABLE              = aws_dynamodb_table.user_follows.name
      APPS_METADATA_TABLE             = aws_dynamodb_table.apps_metadata.name
      APPS_INGEST_SCHEDULE_TABLE      = aws_dynamodb_table.apps_ingest_schedule.name
      DEFAULT_INGEST_INTERVAL_MINUTES = var.default_ingest_interval_minutes
      OPENAI_SECRET_NAME              = var.openai_secret_name
      OPENAI_MODEL                    = var.openai_model
      OPENAI_URL                      = var.openai_url
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
  function_name    = "revox-worker"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "worker.handler"
  runtime          = "nodejs18.x"
  timeout          = 300
  filename         = "${path.module}/dummy.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")

  environment {
    variables = {
      APP_REVIEWS_TABLE = aws_dynamodb_table.app_reviews.name
      APPS_METADATA_TABLE             = aws_dynamodb_table.apps_metadata.name
    }
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

########################################
#  Ressource gérant la lambda user_sync
########################################
resource "aws_lambda_function" "user_sync" {
  function_name    = "revox-user-sync"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "userSync.handler"
  runtime          = "nodejs18.x"
  timeout          = 10
  filename         = "${path.module}/dummy.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")

  environment {
    variables = {
      REVOX_USERS_TABLE = aws_dynamodb_table.users.name
    }
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
  }
}

########################################
#  Ressource gérant la lambda ingest_scheduler
########################################
resource "aws_lambda_function" "ingest_scheduler" {
  function_name    = "revox-ingest-scheduler"
  role             = aws_iam_role.lambda_exec.arn
  handler          = "ingestScheduler.handler"
  runtime          = "nodejs18.x"
  timeout          = 30
  filename         = "${path.module}/dummy.zip"
  source_code_hash = filebase64sha256("${path.module}/dummy.zip")
  kms_key_arn      = aws_kms_key.lambda_env.arn

  environment {
    variables = {
      EXTRACTION_QUEUE_URL             = aws_sqs_queue.extraction_queue.url
      DEFAULT_INGEST_INTERVAL_MINUTES  = var.default_ingest_interval_minutes
      APPS_INGEST_SCHEDULE_TABLE        = aws_dynamodb_table.apps_ingest_schedule.name
      SCHED_BATCH_SIZE                 = var.sched_batch_size
      SCHED_LOCK_MS                    = var.sched_lock_ms
    }
  }

  lifecycle {
    ignore_changes = [
      filename,
      source_code_hash,
    ]
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
        Action   = "logs:PutLogEvents",
        Resource = "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/http-api/revox-api:*"
      }
    ]
  })
}

########################################
# IAM pour Lambda
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

# Clé KMS pour chiffrer les variables d'environnement Lambda
resource "aws_kms_key" "lambda_env" {
  description             = "Clé KMS pour les variables d’environnement Lambda"
  deletion_window_in_days = 7
  enable_key_rotation     = true
}

# permissions secrets manager
resource "aws_iam_role_policy" "lambda_secrets" {
  name = "lambda-secrets"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "secretsmanager:GetSecretValue"
        ],
        Resource = "*"
      }
    ]
  })
}

# Policy KMS autorisant le rôle Lambda à déchiffrer les variables
resource "aws_kms_key_policy" "lambda_env_policy" {
  key_id = aws_kms_key.lambda_env.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Sid : "Allow Lambda Execution Role to decrypt",
        Effect : "Allow",
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
        Sid : "EnableIAMUserPermissions",
        Effect : "Allow",
        Principal : {
          AWS : "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"
        },
        Action : "kms:*",
        Resource : "*"
      }
    ]
  })
}

########################################
# EventBride Ingest Scheduler
########################################

resource "aws_cloudwatch_event_rule" "revox_ingest_scheduler" {
  name                = "revox-ingest-scheduler"
  description         = "Planifie l’exécution de la Lambda revox-ingest-scheduler"
  schedule_expression = var.ingest_scheduler_rate_expression
}

resource "aws_cloudwatch_event_target" "revox_ingest_scheduler_target" {
  rule      = aws_cloudwatch_event_rule.revox_ingest_scheduler.name
  target_id = "revox-ingest-scheduler-lambda"
  arn       = aws_lambda_function.ingest_scheduler.arn
}

resource "aws_lambda_permission" "allow_events_to_invoke_ingest_scheduler" {
  statement_id  = "AllowExecutionFromEventBridgeForIngestScheduler"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest_scheduler.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.revox_ingest_scheduler.arn
}

########################################
# Secrets Manager pour OpenAI
########################################

data "aws_secretsmanager_secret" "openai" {
  name = var.openai_secret_name
}