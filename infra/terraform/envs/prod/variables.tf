variable "region" {
  description = "서울 리전. 국내 개인정보를 국외로 이전하지 않기 위해 고정한다"
  type        = string
  default     = "ap-northeast-2"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "availability_zones" {
  type    = list(string)
  default = ["ap-northeast-2a", "ap-northeast-2c"]
}

variable "certificate_arn" {
  description = "ACM 인증서 ARN. 같은 리전에 있어야 한다"
  type        = string
}

variable "api_image" {
  description = "예: 123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/mediwork-api:sha-abc1234"
  type        = string
}

variable "ai_image" {
  type = string
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 50
}

variable "db_final_snapshot_suffix" {
  description = <<-EOT
    최종 스냅샷 이름 접미사. 같은 이름의 스냅샷이 이미 있으면 DB 삭제가
    실패한다. 날짜 등 매번 달라지는 값을 넣는다.
  EOT
  type        = string
}

variable "cors_origins" {
  description = "웹 앱의 출처. 쉼표로 구분. 비우면 API 기본값(로컬)이 쓰인다"
  type        = string
  default     = ""
}

variable "access_log_bucket" {
  description = "ALB 액세스 로그 버킷. 비우면 로그를 남기지 않는다"
  type        = string
  default     = ""
}
