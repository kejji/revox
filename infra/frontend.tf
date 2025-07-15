provider "aws" {
  alias  = "frontend"
  region = "eu-west-3"
}

resource "aws_s3_bucket" "frontend" {
  provider = aws.frontend
  bucket   = "revox-frontend"

  force_destroy = true

  tags = {
    Name = "Revox Frontend"
    Env  = terraform.workspace
  }
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  provider = aws.frontend
  bucket   = aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  provider = aws.frontend
  bucket   = aws_s3_bucket.frontend.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend_public" {
  provider = aws.frontend
  bucket   = aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Sid       = "PublicReadGetObject",
      Effect    = "Allow",
      Principal = "*",
      Action    = "s3:GetObject",
      Resource  = "${aws_s3_bucket.frontend.arn}/*"
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

