/**
 * 컨테이너 레지스트리.
 *
 * 이미지 태그를 불변으로 둔다. `latest`를 덮어쓰며 배포하면 "지금 운영에
 * 떠 있는 것이 어느 커밋인가"를 사후에 확인할 수 없다. 근태 계산이 틀렸다는
 * 신고가 들어왔을 때 그 시점의 코드를 특정할 수 없으면 조사가 불가능하다.
 */

locals {
  repositories = toset(["mediwork-api", "mediwork-ai"])
}

resource "aws_ecr_repository" "this" {
  for_each = local.repositories

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
  }

  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "최근 30개만 보관. 롤백 대상이 남을 만큼은 유지한다"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = { type = "expire" }
      }
    ]
  })
}

output "ecr_repository_urls" {
  value = { for k, v in aws_ecr_repository.this : k => v.repository_url }
}
