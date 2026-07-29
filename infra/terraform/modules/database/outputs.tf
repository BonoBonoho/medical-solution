output "endpoint" {
  value = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "database_name" {
  value = aws_db_instance.this.db_name
}

output "security_group_id" {
  value = aws_security_group.db.id
}

output "master_user_secret_arn" {
  description = "RDS가 관리하는 마스터 비밀번호 시크릿. 마이그레이션에서만 쓴다"
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "kms_key_arn" {
  value = aws_kms_key.db.arn
}
