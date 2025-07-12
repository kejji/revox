##########################
# AWS Provider Settings
##########################

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
