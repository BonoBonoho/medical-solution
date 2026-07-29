/**
 * 애플리케이션 시크릿.
 *
 * 값은 Terraform이 넣지 않는다. 여기서는 **빈 시크릿 껍데기만** 만들고
 * 값은 사람이 콘솔이나 CLI로 채운다.
 *
 * 이유: Terraform이 값을 다루면 state 파일에 평문으로 남는다. state는
 * S3에 있고 백업되고 여러 사람이 읽는다. DB 접속 문자열과 API 키가
 * 거기 있으면 안 된다.
 *
 * 대신 `ignore_changes`로 사람이 채운 값을 Terraform이 덮어쓰지 않게 한다.
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

resource "aws_kms_key" "secrets" {
  description             = "${var.name} 애플리케이션 시크릿"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  tags                    = var.tags
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

resource "aws_secretsmanager_secret" "app" {
  for_each = var.secret_names

  name        = "${var.name}/${each.key}"
  description = each.value
  kms_key_id  = aws_kms_key.secrets.arn

  # 실수로 지워도 복구할 시간을 둔다. 0으로 즉시 삭제하면 되돌릴 수 없다.
  recovery_window_in_days = 30

  tags = merge(var.tags, { Name = "${var.name}/${each.key}" })
}

resource "aws_secretsmanager_secret_version" "placeholder" {
  for_each = var.secret_names

  secret_id     = aws_secretsmanager_secret.app[each.key].id
  secret_string = "PLACEHOLDER_교체_필요"

  lifecycle {
    # 사람이 실제 값을 넣은 뒤 Terraform이 다시 PLACEHOLDER로 되돌리면
    # 배포가 조용히 깨진다.
    ignore_changes = [secret_string]
  }
}
