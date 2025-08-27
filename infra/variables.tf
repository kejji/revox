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
  default = 30
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
  default = "rate(5 minutes)"
}
