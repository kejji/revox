output "cognito_user_pool_id" {
  value = trimspace(aws_cognito_user_pool.revox_user_pool.id)
}

output "cognito_app_client_id" {
  value = trimspace(aws_cognito_user_pool_client.revox_app_client.id)
}

output "app_reviews_table_name" {
  value = trimspace(aws_dynamodb_table.app_reviews.name)
}

output "extraction_queue_url" {
  description = "URL de la queue SQS pour les extractions"
  value       = trimspace(aws_sqs_queue.extraction_queue.url)
}

output "extraction_queue_arn" {
  description = "ARN de la queue SQS pour les extractions"
  value       = trimspace(aws_sqs_queue.extraction_queue.arn)
}

output "http_api_endpoint" {
  description = "URL publique de l’HTTP API (stage $default)"
  value       = trimspace(aws_apigatewayv2_api.http_api.api_endpoint)
}

output "function_url" {
  description = "URL directe de la Lambda pour debug"
  value       = trimspace(aws_lambda_function_url.api_url.function_url)
}

output "user_follows_table_name" {
  value = trimspace(aws_dynamodb_table.user_follows.name)
}

output "revox_users_table_name" {
  value = trimspace(aws_dynamodb_table.users.name)
}

output "apps_metadata_table_name" {
  value = trimspace(aws_dynamodb_table.users.name)
}