output "secret_arns" {
  description = "이름 → ARN"
  value       = { for k, v in aws_secretsmanager_secret.app : k => v.arn }
}

output "all_secret_arns" {
  value = [for v in aws_secretsmanager_secret.app : v.arn]
}

output "kms_key_arn" {
  value = aws_kms_key.secrets.arn
}
