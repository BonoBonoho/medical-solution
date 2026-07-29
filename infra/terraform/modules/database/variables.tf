variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "DB 서브넷. 인터넷 라우트가 없는 isolated 서브넷이어야 한다"
  type        = list(string)
}

variable "engine_version" {
  type    = string
  default = "17.2"
}

variable "parameter_group_family" {
  type    = string
  default = "postgres17"
}

variable "instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "allocated_storage" {
  type    = number
  default = 50
}

variable "max_allocated_storage" {
  description = "스토리지 자동 확장 상한. 0이면 끈다"
  type        = number
  default     = 500
}

variable "database_name" {
  type    = string
  default = "mediwork"
}

variable "master_username" {
  description = <<-EOT
    마스터 사용자. **애플리케이션이 이 계정으로 접속하면 안 된다.**
    RDS의 마스터 사용자는 rds_superuser 권한을 갖고, 그러면 RLS가 우회된다.
    마이그레이션으로 mediwork_app(NOSUPERUSER NOBYPASSRLS) 롤을 만들어 쓴다.
  EOT
  type        = string
  default     = "mediwork_admin"
}

variable "multi_az" {
  description = "AZ 장애 시 자동 페일오버. 운영에서는 켜야 한다"
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "자동 백업 보존 기간. PITR 가능 범위와 같다"
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 7
    error_message = "근태·급여 기초자료를 다루므로 백업은 최소 7일 이상 보존합니다."
  }
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "final_snapshot_suffix" {
  description = "최종 스냅샷 이름 접미사. 같은 이름의 스냅샷이 있으면 삭제가 실패한다"
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
