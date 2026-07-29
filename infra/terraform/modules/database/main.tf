/**
 * RDS PostgreSQL.
 *
 * 이 DB에는 병원 직원의 인사·근태·휴가 기록이 들어간다. 개인정보보호법상
 * 안전조치 의무 대상이고, 애플리케이션 레벨에서는 RLS로 테넌트를 격리하지만
 * 인프라 레벨에서도 같은 태도를 유지한다.
 *
 *   · isolated 서브넷 — 인터넷 라우트 없음
 *   · publicly_accessible = false
 *   · 저장 시 암호화 (고객 관리형 KMS 키)
 *   · 전송 시 TLS 강제 (rds.force_ssl = 1)
 *   · 삭제 방지 + 최종 스냅샷
 *
 * ⚠️ 애플리케이션 접속 롤은 반드시 비-수퍼유저여야 한다. 수퍼유저로 접속하면
 * RLS가 조용히 우회된다. 마스터 사용자로 앱을 붙이지 말 것.
 * (apps/api/README.md 참고)
 */

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.subnet_ids
  tags       = merge(var.tags, { Name = "${var.name}-db" })
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "RDS PostgreSQL"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-db" })
}

# 인그레스 규칙은 **루트에서** 만든다.
#
# 여기서 앱 보안그룹을 참조하면 database → ecs → database 순환이 생긴다
# (ecs는 아웃바운드 규칙 때문에 db 보안그룹이 필요하다). 방향을 하나로
# 고정하고(ecs가 database에 의존), 반대 방향 규칙만 루트에 둔다.
#
# CIDR로 열지 않는 것이 중요하다 — 서브넷에 다른 것이 들어와도 DB에
# 닿지 못해야 한다.

# 아웃바운드 규칙을 두지 않는다. DB가 어딘가로 접속할 이유가 없다.

resource "aws_kms_key" "db" {
  description             = "${var.name} RDS 암호화"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = merge(var.tags, { Name = "${var.name}-rds" })
}

resource "aws_kms_alias" "db" {
  name          = "alias/${var.name}-rds"
  target_key_id = aws_kms_key.db.key_id
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = var.parameter_group_family

  # 평문 접속을 거부한다. 애플리케이션은 sslmode=require 이상으로 붙어야 한다.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # 느린 쿼리를 남긴다. 근무표 조회가 느려지는 지점을 찾으려면 필요하다.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  # 접속·해제를 남긴다. 침해 사고 시 누가 언제 붙었는지 말할 수 있어야 한다.
  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.db.arn

  db_name  = var.database_name
  username = var.master_username
  # 비밀번호는 Terraform state에 남기지 않는다. RDS가 만들어 Secrets Manager에
  # 넣게 한다. state 파일이 유출돼도 DB 비밀번호는 거기 없다.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.db.arn

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false

  multi_az                   = var.multi_az
  auto_minor_version_upgrade = true

  backup_retention_period = var.backup_retention_days
  backup_window           = "17:00-18:00" # KST 02:00-03:00
  maintenance_window      = "sun:18:00-sun:19:00"
  copy_tags_to_snapshot   = true

  # PITR를 위해 필요하다. 근태 데이터를 실수로 지웠을 때 되돌릴 수 있어야 한다.
  delete_automated_backups = false

  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final-${var.final_snapshot_suffix}"

  parameter_group_name = aws_db_parameter_group.this.name

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.db.arn
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = merge(var.tags, { Name = var.name })

  lifecycle {
    # 엔진 마이너 버전은 자동 업그레이드에 맡긴다. Terraform이 매번
    # 되돌리려 드는 것을 막는다.
    ignore_changes = [engine_version]
  }
}
