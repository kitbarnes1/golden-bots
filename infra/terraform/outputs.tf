output "url" {
  value = "https://${local.hostname}"
}

output "instance_id" {
  description = "Set as the EC2_INSTANCE_ID GitHub Actions variable. Shell in with: aws ssm start-session --target <id>"
  value       = aws_instance.app.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE_ARN GitHub Actions variable."
  value       = aws_iam_role.github_deploy.arn
}

output "backup_bucket" {
  value = aws_s3_bucket.backups.bucket
}

output "github_actions_variables" {
  description = "Paste these into GitHub: Settings > Secrets and variables > Actions > Variables."
  value = {
    AWS_REGION          = var.aws_region
    AWS_DEPLOY_ROLE_ARN = aws_iam_role.github_deploy.arn
    ECR_REPOSITORY      = aws_ecr_repository.app.name
    EC2_INSTANCE_ID     = aws_instance.app.id
  }
}
