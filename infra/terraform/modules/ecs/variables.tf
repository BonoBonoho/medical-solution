variable "name" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "public_subnet_ids" {
  description = "ALB가 들어갈 서브넷"
  type        = list(string)
}

variable "private_subnet_ids" {
  description = "태스크가 들어갈 서브넷. 퍼블릭 IP를 붙이지 않는다"
  type        = list(string)
}

variable "database_security_group_id" {
  type = string
}

variable "certificate_arn" {
  description = "ACM 인증서. HTTPS 리스너에 필요하다"
  type        = string
}

variable "api_image" {
  description = "코어 API 이미지. 태그는 배포 파이프라인이 갱신한다"
  type        = string
}

variable "ai_image" {
  type = string
}

variable "api_port" {
  type    = number
  default = 3000
}

variable "ai_port" {
  type    = number
  default = 3002
}

variable "api_cpu" {
  type    = number
  default = 1024
}

variable "api_memory" {
  type    = number
  default = 2048
}

variable "ai_cpu" {
  description = "CP-SAT는 CPU를 쓴다. 탐색 워커 수와 맞춰야 한다"
  type        = number
  default     = 2048
}

variable "ai_memory" {
  type    = number
  default = 4096
}

variable "ai_desired_count" {
  description = "AI 서비스 태스크 수. 죽어도 근태·근무표 편집은 계속 동작해야 한다"
  type        = number
  default     = 1
}

variable "min_capacity" {
  description = "API 최소 태스크 수. 2 미만이면 배포 중 무중단이 성립하지 않는다"
  type        = number
  default     = 2

  validation {
    condition     = var.min_capacity >= 2
    error_message = "최소 2개여야 배포·AZ 장애 중에도 근태 기록을 받을 수 있습니다."
  }
}

variable "max_capacity" {
  type    = number
  default = 10
}

variable "database_url_secret_arn" {
  description = <<-EOT
    애플리케이션용 DB 접속 문자열 시크릿.
    **비-수퍼유저 롤(mediwork_app)을 가리켜야 한다.** 마스터 사용자로 붙으면
    RLS가 조용히 우회된다.
  EOT
  type        = string
}

variable "anthropic_api_key_secret_arn" {
  description = "자연어 제약 해석용. 빈 문자열이면 주입하지 않는다"
  type        = string
  default     = ""
}

variable "secret_arns" {
  description = "실행 롤이 읽을 시크릿 ARN 목록"
  type        = list(string)
}

variable "secrets_kms_key_arns" {
  description = "시크릿 복호화에 필요한 KMS 키"
  type        = list(string)
  default     = []
}

variable "cors_origins" {
  description = "쉼표로 구분한 허용 출처. 비우면 API가 로컬 기본값을 쓴다"
  type        = string
  default     = ""
}

variable "access_log_bucket" {
  description = "ALB 액세스 로그 버킷. 비우면 로그를 남기지 않는다"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "enable_execute_command" {
  description = <<-EOT
    ECS Exec(컨테이너 셸 접속). 운영에서는 기본 끔.
    켜면 인사 데이터가 있는 컨테이너에 셸로 들어갈 수 있고, 그 접근은
    애플리케이션 감사 로그에 남지 않는다.
  EOT
  type        = bool
  default     = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
