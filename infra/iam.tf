resource "aws_iam_user" "terraform_user" {
  name = "terraform-user"
}

resource "aws_iam_policy" "revox_terraform_permissions" {
  name        = "RevoxTerraformPermissions"
  description = "Permissions complètes pour Terraform: S3 state, DynamoDB lock, Lambda, SQS, Cognito, etc."

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [

      ### --- DYNAMODB LOCK TABLE ---
      {
        Sid    = "TerraformLockTableAccess",
        Effect = "Allow",
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:DeleteItem",
          "dynamodb:DescribeTable",
          "dynamodb:Scan",
          "dynamodb:Query",
          "dynamodb:UpdateItem"
        ],
        Resource = "arn:aws:dynamodb:eu-west-3:588738577999:table/revox-terraform-locks"
      },

      ### --- S3 STATE FILE ---
      {
        Sid    = "TerraformStateAccess",
        Effect = "Allow",
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ],
        Resource = "arn:aws:s3:::revox-terraform-state/revox/dev/terraform.tfstate"
      },
      {
        Sid    = "TerraformStateBucketAccess",
        Effect = "Allow",
        Action = [
          "s3:ListBucket",
          "s3:GetBucketLocation"
        ],
        Resource = "arn:aws:s3:::revox-terraform-state"
      },

      ### --- RDS ---
      {
        Sid    = "RDSAccess",
        Effect = "Allow",
        Action = [
          "rds:CreateDBCluster",
          "rds:DeleteDBCluster",
          "rds:DescribeDBClusters",
          "rds:CreateDBSubnetGroup",
          "rds:DeleteDBSubnetGroup"
        ],
        Resource = "*"
      },

      ### --- SECRETS MANAGER ---
      {
        Sid    = "SecretsManagerAccess",
        Effect = "Allow",
        Action = [
          "secretsmanager:CreateSecret",
          "secretsmanager:PutSecretValue",
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetResourcePolicy"
        ],
        Resource = "*"
      },

      ### --- IAM ---
      {
        Sid    = "IAMAccess",
        Effect = "Allow",
        Action = [
          "iam:CreateRole",
          "iam:PutRolePolicy",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PassRole",
          "iam:ListAttachedRolePolicies",
          "iam:ListRolePolicies",
          "iam:GetRole",
          "iam:CreatePolicy",
          "iam:ListAttachedUserPolicies",
          "iam:AttachUserPolicy"
        ],
        Resource = "*"
      },
      {
        Sid      = "IAMServiceLinkedRoleForRDS",
        Effect   = "Allow",
        Action   = "iam:CreateServiceLinkedRole",
        Resource = "*",
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = "rds.amazonaws.com"
          }
        }
      },

      ### --- LAMBDA ---
      {
        Sid    = "LambdaAccess",
        Effect = "Allow",
        Action = [
          "lambda:CreateFunction",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
          "lambda:GetFunction",
          "lambda:GetFunctionConfiguration",
          "lambda:GetFunctionCodeSigningConfig",
          "lambda:GetFunctionUrlConfig",
          "lambda:CreateFunctionUrlConfig",
          "lambda:UpdateFunctionUrlConfig",
          "lambda:DeleteFunctionUrlConfig",
          "lambda:GetPolicy",
          "lambda:DeleteFunction",
          "lambda:ListFunctions",
          "lambda:ListVersionsByFunction",
          "lambda:ListTags",
          "lambda:AddPermission",
          "lambda:RemovePermission",
          "lambda:CreateEventSourceMapping",
          "lambda:UpdateEventSourceMapping",
          "lambda:GetEventSourceMapping",
          "lambda:ListEventSourceMappings",
          "lambda:DeleteEventSourceMapping"        ],
        Resource = "*"
      },

      ### --- LOGS ---
      {
        Sid    = "CloudWatchLogsAccess",
        Effect = "Allow",
        Action = [
          "logs:CreateLogGroup",
          "logs:PutRetentionPolicy",
          "logs:DescribeLogGroups",
          "logs:ListTagsForResource",
          "logs:DeleteLogGroup",
          "logs:CreateLogDelivery",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DeleteResourcePolicy",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogStreams",
          "logs:ListLogDeliveries",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery"
        ],
        Resource = "*"
      },

      ### --- DYNAMODB APP ---
      {
        Sid    = "DynamoDBAccess",
        Effect = "Allow",
        Action = [
          "dynamodb:CreateTable",
          "dynamodb:DescribeTable",
          "dynamodb:ListTables",
          "dynamodb:DeleteTable",
          "dynamodb:UpdateTable",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:PutItem",
          "dynamodb:DescribeContinuousBackups",
          "dynamodb:DescribeTimeToLive",
          "dynamodb:ListTagsOfResource"
        ],
        Resource = "*"
      },

      ### --- SQS ---
      {
        Sid    = "SQSAccess",
        Effect = "Allow",
        Action = [
          "sqs:CreateQueue",
          "sqs:ListQueues",
          "sqs:GetQueueUrl",
          "sqs:SendMessage",
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:DeleteQueue",
          "sqs:ListQueueTags"
        ],
        Resource = "*"
      },

      ### --- API GATEWAY ---
      {
        Sid    = "APIGatewayAccess",
        Effect = "Allow",
        Action = [
          "apigateway:GET",
          "apigateway:POST",
          "apigateway:PUT",
          "apigateway:PATCH",
          "apigateway:DELETE"
        ],
        Resource = "*"
      },

      ### --- S3 ---
      {
        Sid    = "S3Access",
        Effect = "Allow",
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:ListBucket",
          "s3:GetBucketLocation",
          "s3:GetBucketAcl",
          "s3:GetBucketCORS",
          "s3:GetBucketVersioning",
          "s3:GetBucketWebsite",
          "s3:GetBucketPolicy",
          "s3:GetBucketPublicAccessBlock",
          "s3:GetAccelerateConfiguration",
          "s3:GetBucketRequestPayment",
          "s3:GetBucketLogging",
          "s3:GetLifecycleConfiguration",
          "s3:GetReplicationConfiguration",
          "s3:GetEncryptionConfiguration",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketTagging",
          "s3:PutBucketPolicy"
        ],
        Resource = "*"
      },

      ### --- COGNITO ---
      {
        Sid    = "CognitoAccess",
        Effect = "Allow",
        Action = [
          "cognito-idp:GetUserPoolMfaConfig",
          "cognito-idp:DescribeUserPool",
          "cognito-idp:DescribeUserPoolClient"
        ],
        Resource = "*"
      }
    ]
  })
}

resource "aws_iam_user_policy_attachment" "attach_revox_policy" {
  user       = aws_iam_user.terraform_user.name
  policy_arn = aws_iam_policy.revox_terraform_permissions.arn
}

# Accès lecture Dynamodb pour terraform-user
resource "aws_iam_user_policy_attachment" "terraform_user_dynamodb_ro" {
  user       = aws_iam_user.terraform_user.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess"
}

# Policy inline minimale: Secrets Manager GetSecretValue sur CE secret
resource "aws_iam_user_policy" "terraform_user_read_openai_secret" {
  name = "terraform-user-ReadOpenAISecret"
  user = aws_iam_user.terraform_user.name

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        "Effect": "Allow",
        "Action": [ "secretsmanager:GetSecretValue" ],
        # l'ARN exact du secret, avec wildcard pour le suffixe généré par AWS
        "Resource": "${data.aws_secretsmanager_secret.openai.arn}*"
      }
    ]
  })
}

# Autoriser le user à voir les envs (kms:Decrypt sur la clé lambda_env)
resource "aws_iam_user_policy" "terraform_user_kms_decrypt_lambda_env" {
  name = "terraform-user-KMSDecrypt-LambdaEnv"
  user = aws_iam_user.terraform_user.name

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect   = "Allow",
      Action   = ["kms:Decrypt", "kms:DescribeKey"],
      Resource = aws_kms_key.lambda_env.arn
    }]
  })
}

# Autoriser le user à invoquer lambda themesScheduleRunner
resource "aws_iam_policy" "lambda_invoke_revox_themes" {
  name        = "lambda-invoke-revox-themes"
  description = "Allow invoking revox-themes-scheduler"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Sid    = "InvokeSpecificFunction",
      Effect = "Allow",
      Action = ["lambda:InvokeFunction"],
      Resource = "*"
    }]
  })
}

resource "aws_iam_user_policy_attachment" "terraform_user_invoke_revox_themes" {
  user = aws_iam_user.terraform_user.name
  policy_arn = aws_iam_policy.lambda_invoke_revox_themes.arn
}

resource "aws_iam_user_policy" "terraform_user_iam_readonly_inline" {
  name = "terraform-user-IAMReadOnly"
  user = aws_iam_user.terraform_user.name

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect: "Allow",
      Action: [
        "iam:GetUser",
        "iam:ListUserPolicies",
        "iam:ListAttachedUserPolicies",
        "iam:GetPolicy",
        "iam:GetPolicyVersion"
      ],
      Resource: "*"
    }]
  })
}

# Autoriser terraform-user à invoquer la Lambda revox-themes-scheduler
resource "aws_iam_user_policy" "terraform_user_invoke_revox_themes_inline" {
  name = "terraform-user-Invoke-revox-themes"
  user = aws_iam_user.terraform_user.name

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect   = "Allow",
      Action   = ["lambda:InvokeFunction"],
      Resource = [
        "arn:aws:lambda:eu-west-3:588738577999:function:revox-themes-scheduler",
        "arn:aws:lambda:eu-west-3:588738577999:function:revox-themes-scheduler:*" # versions & alias
      ]
    }]
  })
}

resource "aws_iam_role_policy" "api_can_invoke_themes_scheduler" {
  name = "api-can-invoke-themes-scheduler"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow",
        Action   = ["lambda:InvokeFunction"],
        Resource = aws_lambda_function.themes_scheduler.arn
      }
    ]
  })
}