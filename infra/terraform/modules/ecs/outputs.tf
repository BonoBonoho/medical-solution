output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "api_service_name" {
  value = aws_ecs_service.api.name
}

output "ai_service_name" {
  value = aws_ecs_service.ai.name
}

output "app_security_group_id" {
  description = "DB 모듈의 allowed_security_group_ids에 넣는다"
  value       = aws_security_group.app.id
}
