variable "aws_region" {
  description = "Région AWS"
  type        = string
  default     = "eu-west-3"
}

variable "aws_profile" {
  description = "Profile AWS CLI à utiliser"
  type        = string
  default     = "revox-admin"
}

variable "default_ingest_interval_minutes" {
  type    = number
  default = 3
}

variable "sched_batch_size" {
  type    = number
  default = 100
}

variable "sched_lock_ms" {
  type    = number
  default = 600000 # 10 minutes
}

variable "ingest_scheduler_rate_expression" {
  type    = string
  default = "rate(2 minutes)"
}

variable "openai_secret_name" {
  description = "Nom du secret Secrets Manager qui contient la clé OpenAI (le champ 'secretString')"
  type        = string
  default     = "openai/api-key"
}

variable "openai_model" {
  description = "Modèle OpenAI à utiliser"
  type        = string
  default     = "gpt-4o-mini"
}

variable "openai_url" {
  description = "Endpoint Chat Completions OpenAI"
  type        = string
  default     = "https://api.openai.com/v1/chat/completions"
}
