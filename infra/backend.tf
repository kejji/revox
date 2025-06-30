terraform {
  backend "s3" {
    bucket         = "revox-terraform-state"
    key            = "revox/dev/terraform.tfstate"
    region         = "eu-west-3"
    dynamodb_table = "revox-terraform-locks"
    encrypt        = true
  }
}

