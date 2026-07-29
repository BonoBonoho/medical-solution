variable "name" {
  description = "리소스 이름 접두사"
  type        = string
}

variable "region" {
  description = "VPC 엔드포인트 서비스명에 쓴다"
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. /16을 권장한다 — 서브넷을 /20씩 12개로 쪼갠다"
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.cidr_block))
    error_message = "유효한 CIDR이어야 합니다."
  }
}

variable "availability_zones" {
  description = "가용영역. 2개 이상이어야 RDS Multi-AZ와 ALB가 성립한다"
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "가용영역은 2개 이상이어야 합니다. 1개면 AZ 장애 시 서비스가 통째로 멈춥니다."
  }
}

variable "enable_nat_gateway" {
  description = "앱 서브넷의 아웃바운드 인터넷 접근. 끄면 VPC 엔드포인트로만 통신한다"
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = <<-EOT
    NAT Gateway를 하나만 둔다. 개발 환경의 비용 절감용이다.
    운영에서 true로 두면 해당 AZ 장애 시 다른 AZ의 앱도 아웃바운드가 끊긴다.
  EOT
  type        = bool
  default     = false
}

variable "enable_interface_endpoints" {
  description = "ECR·CloudWatch·Secrets Manager 인터페이스 엔드포인트. 시간당 과금이 있다"
  type        = bool
  default     = true
}

variable "enable_flow_logs" {
  description = "VPC 플로우 로그. 개인정보 처리 시스템에서는 켜 두어야 한다"
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "플로우 로그 보존 기간"
  type        = number
  default     = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
