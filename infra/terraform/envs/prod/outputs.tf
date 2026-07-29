output "alb_dns_name" {
  description = "DNS의 CNAME/ALIAS 대상"
  value       = module.ecs.alb_dns_name
}

output "alb_zone_id" {
  value = module.ecs.alb_zone_id
}

output "database_endpoint" {
  value = module.database.endpoint
}

output "database_master_secret_arn" {
  description = "마스터 비밀번호. **마이그레이션에서만** 쓴다. 애플리케이션은 mediwork_app 롤로 붙는다"
  value       = module.database.master_user_secret_arn
}

output "ecs_cluster_name" {
  value = module.ecs.cluster_name
}

output "api_service_name" {
  value = module.ecs.api_service_name
}

output "ai_service_name" {
  value = module.ecs.ai_service_name
}

output "secret_arns" {
  description = "값은 비어 있다. 배포 전 실제 값으로 채워야 한다"
  value       = module.secrets.secret_arns
}
