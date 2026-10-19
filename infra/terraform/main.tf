locals {
  hostname   = "${var.subdomain}.${var.domain}"
  ssm_prefix = "/${var.name}"
  subnet_id  = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.default.ids)[0]
}

data "aws_caller_identity" "current" {}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

data "aws_subnet" "selected" {
  id = local.subnet_id
}

# Latest Amazon Linux 2023 for ARM. Changes are ignored on the instance so a new
# AMI never replaces a running server by surprise.
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# ------------------------------------------------------------------ images

resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 15 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 15
      }
      action = { type = "expire" }
    }]
  })
}

# ----------------------------------------------------------------- backups

resource "aws_s3_bucket" "backups" {
  bucket_prefix = "${var.name}-backups-"
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "expire-old-backups"
    status = "Enabled"
    filter {
      prefix = "backups/"
    }
    expiration {
      days = var.backup_retention_days
    }
  }
}

# ----------------------------------------------------------------- secrets
# The instance renders these into env files on every deploy (see deploy.sh).

resource "aws_ssm_parameter" "app" {
  # Parameters can't be empty, so optional keys are only added when set. (Whether a key is
  # set isn't secret; nonsensitive() lets for_each use that.)
  for_each = merge(
    {
      ADMIN_PASSWORD = var.admin_password
      PUBLIC_URL     = "https://${local.hostname}"
    },
    nonsensitive(var.openrouter_api_key != "") ? { OPENROUTER_API_KEY = var.openrouter_api_key } : {},
    nonsensitive(var.huggingface_token != "") ? { HF_TOKEN = var.huggingface_token } : {},
    var.extra_app_env,
  )

  name  = "${local.ssm_prefix}/app/${each.key}"
  type  = "SecureString"
  value = each.value
}

resource "aws_ssm_parameter" "tunnel_token" {
  name  = "${local.ssm_prefix}/tunnel/TUNNEL_TOKEN"
  type  = "SecureString"
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.app.token
}

# ---------------------------------------------------------------- instance

resource "aws_iam_role" "instance" {
  name = "${var.name}-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# Shell access via SSM Session Manager (no SSH keys, no open ports), and the
# target for deploy commands from GitHub Actions.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.backups.arn}/backups/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.name}-instance"
  role = aws_iam_role.instance.name
}

# No inbound rules at all: the Cloudflare Tunnel dials out.
resource "aws_security_group" "instance" {
  name        = "${var.name}-instance"
  description = "Golden Balls app server (egress only)"
  vpc_id      = data.aws_subnet.selected.vpc_id

  egress {
    description = "All outbound (OpenRouter, Cloudflare, AWS APIs, package repos)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# The database lives on its own volume so it survives instance replacement.
resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = {
    Name = "${var.name}-data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_arm64.value
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.instance.id]
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  associate_public_ip_address = true

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }

  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region          = var.aws_region
    ssm_prefix      = local.ssm_prefix
    registry        = split("/", aws_ecr_repository.app.repository_url)[0]
    repository_url  = aws_ecr_repository.app.repository_url
    backup_bucket   = aws_s3_bucket.backups.bucket
    data_volume_id  = replace(aws_ebs_volume.data.id, "-", "")
    compose_version = "v2.40.3"
    cloudflared     = "cloudflare/cloudflared:2026.9.3"
  })

  tags = {
    Name = var.name
  }

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  # Secrets must exist before first boot renders them.
  depends_on = [aws_ssm_parameter.app, aws_ssm_parameter.tunnel_token]
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.app.id
}
