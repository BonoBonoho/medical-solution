/**
 * 운영 환경.
 *
 * ⚠️ 이 구성은 **실제로 apply된 적이 없다.** 이 저장소에 유효한 AWS
 * 자격증명이 없어 `terraform validate`와 `plan`(자격증명 없이 가능한 범위)
 * 까지만 확인했다. 실제 적용 전 반드시 `terraform plan` 결과를 눈으로
 * 확인할 것.
 *
 * 과금되는 리소스: RDS(Multi-AZ), NAT Gateway ×2, ALB, ECS Fargate,
 * 인터페이스 VPC 엔드포인트 ×4, KMS 키 ×2. NAT와 인터페이스 엔드포인트는
 * 트래픽이 0이어도 시간당 과금이 붙는다.
 */

terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # state에는 리소스 식별자와 설정이 들어간다. 비밀번호는 넣지 않도록
  # 설계했지만(RDS 관리형 비밀번호, 시크릿 값 미관리) 그래도 암호화하고
  # 잠금을 건다.
  backend "s3" {
    # 아래 값은 `terraform init -backend-config=backend.hcl`로 넣는다.
    # 버킷 이름을 코드에 박으면 환경을 복제할 때마다 고쳐야 한다.
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

locals {
  name = "mediwork-${var.environment}"

  tags = {
    Project     = "mediwork"
    Environment = var.environment
    ManagedBy   = "terraform"
    # 개인정보를 처리하는 리소스임을 태그로 표시한다. 접근 통제 정책과
    # 비용 배분에 함께 쓴다.
    DataClass = "personal-data"
  }
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  region             = var.region
  cidr_block         = var.vpc_cidr
  availability_zones = var.availability_zones

  enable_nat_gateway         = true
  single_nat_gateway         = false
  enable_interface_endpoints = true
  enable_flow_logs           = true

  tags = local.tags
}

module "secrets" {
  source = "../../modules/secrets"

  name = local.name

  secret_names = {
    "database-url"      = "애플리케이션 DB 접속 문자열. 반드시 mediwork_app(비-수퍼유저) 롤이어야 함"
    "anthropic-api-key" = "자연어 제약 해석용. 없으면 구조화 제약만으로 근무표를 생성함"
  }

  tags = local.tags
}

module "database" {
  source = "../../modules/database"

  name       = local.name
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.isolated_subnet_ids

  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  multi_az              = true
  backup_retention_days = 14
  deletion_protection   = true
  final_snapshot_suffix = var.db_final_snapshot_suffix

  tags = local.tags
}

module "ecs" {
  source = "../../modules/ecs"

  name               = local.name
  vpc_id             = module.network.vpc_id
  public_subnet_ids  = module.network.public_subnet_ids
  private_subnet_ids = module.network.private_subnet_ids

  database_security_group_id = module.database.security_group_id
  certificate_arn            = var.certificate_arn

  api_image = var.api_image
  ai_image  = var.ai_image

  database_url_secret_arn      = module.secrets.secret_arns["database-url"]
  anthropic_api_key_secret_arn = module.secrets.secret_arns["anthropic-api-key"]
  secret_arns                  = module.secrets.all_secret_arns
  secrets_kms_key_arns         = [module.secrets.kms_key_arn]

  cors_origins      = var.cors_origins
  access_log_bucket = var.access_log_bucket

  min_capacity = 2
  max_capacity = 10

  tags = local.tags
}

/**
 * DB ← 앱 인그레스.
 *
 * 모듈 안에 두면 database → ecs → database 순환이 생겨 여기 둔다.
 * CIDR이 아니라 보안그룹을 참조한다 — 앱 서브넷에 다른 것이 들어와도
 * DB에 닿지 못해야 한다.
 */
resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = module.database.security_group_id
  description                  = "ECS 태스크에서의 PostgreSQL"
  referenced_security_group_id = module.ecs.app_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
