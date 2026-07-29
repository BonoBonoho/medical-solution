/**
 * ECS Fargate + ALB.
 *
 * 코어 API는 ALB 뒤 private 서브넷에서 돈다. AI 서비스는 **ALB에 붙이지
 * 않는다** — 인터넷에서 접근할 이유가 없고, 입력에 구성원 이름과 휴가
 * 일정이 들어 있다. 코어 API가 서비스 디스커버리로 내부 호출한다.
 * (docs/08-ai-features.md §9.1)
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

data "aws_region" "current" {}

# -- 클러스터 ----------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = var.min_capacity
  }
}

# -- 보안그룹 ----------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-alb" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

# HTTP는 HTTPS로 리다이렉트하기 위해서만 연다.
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (HTTPS로 리다이렉트)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "앱 컨테이너로"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.api_port
  to_port                      = var.api_port
  ip_protocol                  = "tcp"
}

resource "aws_security_group" "app" {
  name        = "${var.name}-app"
  description = "ECS 태스크"
  vpc_id      = var.vpc_id
  tags        = merge(var.tags, { Name = "${var.name}-app" })
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "ALB에서만"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.api_port
  to_port                      = var.api_port
  ip_protocol                  = "tcp"
}

# AI 서비스는 코어 API에서만 호출된다. 같은 보안그룹 안의 통신을 허용한다.
resource "aws_vpc_security_group_ingress_rule" "app_internal" {
  security_group_id            = aws_security_group.app.id
  description                  = "코어 API → AI 서비스"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.ai_port
  to_port                      = var.ai_port
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "app_https" {
  security_group_id = aws_security_group.app.id
  description       = "ECR·Secrets Manager·CloudWatch (VPC 엔드포인트 경유)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = aws_security_group.app.id
  description                  = "PostgreSQL"
  referenced_security_group_id = var.database_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "app_internal" {
  security_group_id            = aws_security_group.app.id
  description                  = "AI 서비스로"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.ai_port
  to_port                      = var.ai_port
  ip_protocol                  = "tcp"
}

# -- ALB ---------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  # 근태 기록 요청의 출처를 추적할 수 있어야 한다. 위치 검증 분쟁 시 필요하다.
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true

  # 버킷이 지정됐을 때만 블록을 만든다. enabled=false + 빈 bucket 조합은
  # 프로바이더가 거부한다.
  dynamic "access_logs" {
    for_each = var.access_log_bucket == "" ? [] : [var.access_log_bucket]
    content {
      bucket  = access_logs.value
      prefix  = var.name
      enabled = true
    }
  }

  tags = var.tags
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = var.api_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
    matcher             = "200"
  }

  # 배포 중 진행 중인 요청을 끊지 않는다. 출퇴근 기록이 유실되면
  # 사용자는 두 번 찍어야 하고, 그러면 기록이 이상해진다.
  deregistration_delay = 30

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# -- IAM ---------------------------------------------------------------------

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# 실행 롤: 이미지 pull, 로그 쓰기, 시크릿 주입.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }

  dynamic "statement" {
    for_each = var.secrets_kms_key_arns
    content {
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "${var.name}-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

# 태스크 롤: 애플리케이션 자신의 권한. 지금은 아무것도 필요 없다.
# 필요해지면 여기에만 붙인다 — 실행 롤에 섞으면 권한이 조용히 넓어진다.
resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
  tags               = var.tags
}

# -- 로그 --------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${var.name}/api"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "ai" {
  name              = "/ecs/${var.name}/ai"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

# -- 서비스 디스커버리 -------------------------------------------------------

resource "aws_service_discovery_private_dns_namespace" "this" {
  name        = "${var.name}.internal"
  description = "서비스 간 내부 통신"
  vpc         = var.vpc_id
  tags        = var.tags
}

resource "aws_service_discovery_service" "ai" {
  name = "ai"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id
    dns_records {
      ttl  = 10
      type = "A"
    }
    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = var.tags
}

# -- 태스크 정의 -------------------------------------------------------------

locals {
  ai_endpoint = "http://ai.${aws_service_discovery_private_dns_namespace.this.name}:${var.ai_port}"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.api_image
      essential = true

      portMappings = [{ containerPort = var.api_port, protocol = "tcp" }]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.api_port) },
        { name = "AI_SERVICE_URL", value = local.ai_endpoint },
        { name = "CORS_ORIGINS", value = var.cors_origins },
        # 근로시간 계산은 서버 TZ에 의존하지 않지만(도메인 패키지가 오프셋을
        # 명시적으로 받는다), 로그 시각을 읽기 쉽게 맞춰 둔다.
        { name = "TZ", value = "Asia/Seoul" },
      ]

      # DB 접속 문자열은 환경변수 평문이 아니라 시크릿으로 주입한다.
      # 태스크 정의는 콘솔에서 그대로 보인다.
      secrets = [
        { name = "DATABASE_URL", valueFrom = var.database_url_secret_arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.api.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "api"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://localhost:${var.api_port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      readonlyRootFilesystem = true
      user                   = "1000:1000"
    }
  ])

  tags = var.tags
}

resource "aws_ecs_task_definition" "ai" {
  family                   = "${var.name}-ai"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ai_cpu
  memory                   = var.ai_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([
    {
      name      = "ai"
      image     = var.ai_image
      essential = true

      portMappings = [{ containerPort = var.ai_port, protocol = "tcp" }]

      environment = [
        { name = "PORT", value = tostring(var.ai_port) },
        # 내부 서비스다. 스키마에 구성원 이름·휴가 필드가 그대로 드러난다.
        { name = "EXPOSE_DOCS", value = "0" },
      ]

      secrets = var.anthropic_api_key_secret_arn == "" ? [] : [
        { name = "ANTHROPIC_API_KEY", valueFrom = var.anthropic_api_key_secret_arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.ai.name
          "awslogs-region"        = data.aws_region.current.name
          "awslogs-stream-prefix" = "ai"
        }
      }

      readonlyRootFilesystem = true
      user                   = "1000:1000"
    }
  ])

  tags = var.tags
}

# -- 서비스 ------------------------------------------------------------------

resource "aws_ecs_service" "api" {
  name            = "${var.name}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.min_capacity
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.api_port
  }

  # 배포 중 실패하면 자동으로 되돌린다. 근태 기록을 받는 서비스가
  # 깨진 채로 남아 있으면 그 시간의 출퇴근이 통째로 유실된다.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  health_check_grace_period_seconds = 60
  enable_execute_command            = var.enable_execute_command

  depends_on = [aws_lb_listener.https]

  lifecycle {
    # 이미지 태그는 배포 파이프라인이 바꾼다. Terraform이 되돌리지 않게 한다.
    ignore_changes = [task_definition, desired_count]
  }

  tags = var.tags
}

resource "aws_ecs_service" "ai" {
  name            = "${var.name}-ai"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.ai.arn
  desired_count   = var.ai_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.ai.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  enable_execute_command = var.enable_execute_command

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  tags = var.tags
}

# -- 오토스케일링 ------------------------------------------------------------

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_capacity
  max_capacity       = var.max_capacity
}

# 3교대 병동은 출퇴근이 07시·15시·23시에 몰린다. CPU 기반 스케일링은
# 반응이 늦으므로, 실측 후 예약 스케일링(scheduled action)을 함께 두는 편이 낫다.
resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
