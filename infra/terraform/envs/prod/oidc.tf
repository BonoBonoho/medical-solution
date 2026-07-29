/**
 * GitHub Actions용 OIDC 역할.
 *
 * 장기 액세스 키를 GitHub Secrets에 넣지 않는다. 키는 유출되면 회수까지
 * 시간이 걸리고, 회수했는지 확인할 방법도 마땅치 않다. OIDC는 워크플로
 * 실행마다 단기 자격증명을 발급받는다.
 *
 * `sub` 조건을 **브랜치까지** 좁히는 것이 중요하다. `repo:org/repo:*`로
 * 두면 누구든 포크에서 PR을 열어 이 역할을 가져갈 수 있다.
 */

variable "github_repository" {
  description = "예: BonoBonoho/medical-solution"
  type        = string
}

variable "github_deploy_ref" {
  description = "배포를 허용할 ref. 예: refs/heads/main"
  type        = string
  default     = "refs/heads/main"
}

data "aws_caller_identity" "current" {}

# OIDC 프로바이더는 계정당 하나다. 이미 있으면 import 하거나 이 리소스를 뺀다.
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
  tags            = local.tags
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:${var.github_deploy_ref}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "github_deploy" {
  # ECR 푸시
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for r in aws_ecr_repository.this : r.arn]
  }

  # 태스크 정의 갱신 + 서비스 배포. 클러스터 삭제 권한은 주지 않는다.
  statement {
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
    ]
    resources = ["*"]
  }

  # 태스크 정의에 롤을 붙이려면 필요하다. 대상 롤을 두 개로 한정한다.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-execution",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.name}-task",
    ]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

output "github_deploy_role_arn" {
  description = "GitHub Actions의 role-to-assume에 넣는다"
  value       = aws_iam_role.github_deploy.arn
}
