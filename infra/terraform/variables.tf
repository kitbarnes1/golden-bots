variable "aws_region" {
  description = "AWS region to run in."
  type        = string
  default     = "eu-west-2"
}

variable "name" {
  description = "Name prefix for resources."
  type        = string
  default     = "golden-balls"
}

variable "instance_type" {
  description = "EC2 instance type. Must be ARM (Graviton) to match the AMI: t4g.micro is enough for a few concurrent games."
  type        = string
  default     = "t4g.small"
}

variable "subnet_id" {
  description = "Public subnet for the instance. Leave empty to use a subnet of the default VPC."
  type        = string
  default     = ""
}

variable "data_volume_size_gb" {
  description = "Size of the EBS volume that holds the SQLite database."
  type        = number
  default     = 10
}

variable "domain" {
  description = "Your Cloudflare zone."
  type        = string
  default     = "thekitbarnes.com"
}

variable "subdomain" {
  description = "The app is served at <subdomain>.<domain>."
  type        = string
  default     = "goldenballs"
}

variable "cloudflare_account_id" {
  description = "Cloudflare account id (dashboard sidebar, or the URL)."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Zone id of the domain (Cloudflare dashboard > domain > Overview)."
  type        = string
}

variable "openrouter_api_key" {
  description = "OpenRouter API key (https://openrouter.ai/keys)."
  type        = string
  sensitive   = true
}

variable "admin_password" {
  description = "Password needed to start, stop and delete games. Viewing is public."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.admin_password) >= 8
    error_message = "Use an admin password of at least 8 characters."
  }
}

variable "extra_app_env" {
  description = "Other app settings, e.g. { AUTOPLAY_INTERVAL_MINUTES = \"120\", MAX_CONCURRENT_GAMES = \"2\" }."
  type        = map(string)
  default     = {}
}

variable "github_repository" {
  description = "owner/repo allowed to deploy via GitHub Actions."
  type        = string
  default     = "kitbarnes1/golden_balls"
}

variable "github_deploy_branch" {
  description = "Branch whose pushes may deploy."
  type        = string
  default     = "main"
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub Actions OIDC provider. Set false if your AWS account already has one."
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "How long nightly database backups are kept in S3."
  type        = number
  default     = 90
}
