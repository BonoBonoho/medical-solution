# 인프라

AWS 서울 리전(`ap-northeast-2`) Terraform 구성.

> ## ⚠️ 이 구성은 실제로 적용된 적이 없다
>
> 이 저장소에는 유효한 AWS 자격증명이 없어 `terraform plan`도 `apply`도
> 실행하지 못했다.
>
> **검증된 것**: GitHub Actions의 `terraform` 잡이 AWS 프로바이더 v5.100.0을
> 내려받아 `terraform init` + `validate`를 통과했다. 속성 이름·필수 인자·타입·
> 모듈 간 참조는 프로바이더 스키마에 대해 확인됐다.
> (개발 환경에서는 네트워크 정책이 `registry.terraform.io`를 막아 `fmt`까지만
> 가능했고, CI가 그 공백을 메운다.)
>
> **검증되지 않은 것**: 실제 AWS 계정에서의 동작. `validate`는 IAM 권한,
> 서비스 할당량, 리전별 가용성, 리소스 간 런타임 제약(예: 인증서 리전 일치,
> 서브넷 CIDR 충돌)을 확인하지 않는다.
>
> **`plan` 결과를 눈으로 확인한 뒤에 `apply` 할 것.**

## 구성

```
                        인터넷
                          │
                    ┌─────▼─────┐  public 서브넷 (AZ×2)
                    │    ALB    │  :443 (TLS 1.3), :80 → 리다이렉트
                    └─────┬─────┘
                          │
        ┌─────────────────▼─────────────────┐  private 서브넷 (AZ×2)
        │  ECS Fargate (ARM64)              │  퍼블릭 IP 없음
        │   ├─ api  ×2~10  (ALB 타깃)        │
        │   └─ ai   ×1     (내부 DNS만)      │  ← ALB에 붙이지 않는다
        └─────────────────┬─────────────────┘
                          │ 5432
        ┌─────────────────▼─────────────────┐  isolated 서브넷 (AZ×2)
        │  RDS PostgreSQL 17 (Multi-AZ)     │  인터넷 라우트 없음
        └───────────────────────────────────┘
```

| 모듈 | 내용 |
|---|---|
| `modules/network` | VPC, 3-티어 서브넷, NAT, VPC 엔드포인트, 플로우 로그 |
| `modules/database` | RDS PostgreSQL, KMS, 파라미터 그룹 |
| `modules/ecs` | 클러스터, ALB, 태스크 정의, 서비스, 오토스케일링, IAM |
| `modules/secrets` | Secrets Manager 껍데기 (값은 넣지 않는다) |
| `envs/prod` | 운영 환경 조립 + ECR + GitHub OIDC |

## 설계에서 의도한 것들

**DB 서브넷에 인터넷 라우트를 두지 않는다.** 병원 인사·근태 데이터가 담긴
DB가 아웃바운드 경로를 가질 이유가 없고, 침해 시 반출 경로가 하나 줄어든다.
DB 보안그룹에는 아웃바운드 규칙 자체가 없다.

**AI 서비스를 ALB에 붙이지 않는다.** 입력에 구성원 이름과 휴가 일정이 들어
있다. 코어 API가 서비스 디스커버리(`ai.mediwork-prod.internal`)로 내부
호출한다.

**DB 접근은 CIDR이 아니라 보안그룹으로 연다.** 앱 서브넷에 다른 것이 들어와도
DB에 닿지 못해야 한다.

**비밀번호를 Terraform이 다루지 않는다.** RDS 마스터 비밀번호는
`manage_master_user_password`로 RDS가 만들어 Secrets Manager에 넣는다.
애플리케이션 시크릿은 빈 껍데기만 만들고 값은 사람이 채우며,
`ignore_changes`로 Terraform이 되돌리지 않게 한다.
**state 파일이 유출돼도 거기에 비밀번호는 없다.**

**이미지 태그가 불변이다.** `latest`를 덮어쓰면 "지금 운영에 떠 있는 것이 어느
커밋인가"를 사후에 확인할 수 없다. 근태 계산이 틀렸다는 신고가 들어왔을 때
그 시점의 코드를 특정하지 못하면 조사가 불가능하다.

**배포는 수동 트리거다.** main 푸시마다 자동 배포하면 근태 기록을 받는
서비스가 검토 없이 바뀐다. 출퇴근이 몰리는 07·15·23시에 배포가 걸리면 그
시간의 기록이 흔들린다.

**GitHub Actions는 OIDC로 붙는다.** 장기 액세스 키를 Secrets에 넣지 않는다.
`sub` 조건을 `refs/heads/main`까지 좁혀 포크에서 PR을 열어 역할을 가져가지
못하게 한다.

**API 최소 태스크 수가 2다.** 변수 검증으로 강제한다. 1개면 배포 중이나 AZ
장애 시 출퇴근 기록을 받을 수 없다.

## 적용 순서

```bash
# 0. state 버킷을 Terraform 밖에서 먼저 만든다 (backend.hcl.example 참고)

cd infra/terraform/envs/prod
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
# 두 파일을 실제 값으로 채운다

terraform init -backend-config=backend.hcl
terraform validate
terraform plan -out=tfplan     # ← 반드시 눈으로 확인
terraform apply tfplan
```

`api_image`/`ai_image`는 첫 apply 때 값이 필요하다. 닭-달걀 문제라
① ECR만 먼저 만들고(`-target=aws_ecr_repository.this`), ② 이미지를 푸시한 뒤,
③ 전체를 apply 하는 순서가 편하다.

apply 후 해야 할 일:

1. **애플리케이션 DB 롤 생성 + 스키마 적용.**
   ```sql
   -- 마스터 사용자로 접속해서 (bastion 또는 일회성 ECS 태스크 경유)
   \i apps/api/src/db/schema.sql
   ALTER ROLE mediwork_app WITH PASSWORD '...';
   ```
   ⚠️ **애플리케이션은 절대 마스터 사용자로 붙이면 안 된다.** RDS 마스터
   사용자는 `rds_superuser` 권한을 갖고, 수퍼유저는 RLS를 통째로 우회한다.
   경고도 오류도 없이 다른 병원의 데이터가 보이게 된다.

2. **시크릿 값 채우기.** `mediwork-prod/database-url`에 `mediwork_app` 롤의
   접속 문자열을 넣는다. `sslmode=require`를 포함해야 한다
   (`rds.force_ssl=1`이라 평문 접속은 거부된다).

3. **GitHub Secrets에 `AWS_DEPLOY_ROLE_ARN` 등록.**
   `terraform output github_deploy_role_arn` 값.

4. **DNS.** `alb_dns_name`을 ALIAS로 연결한다.

## 비용

트래픽이 0이어도 시간당 과금되는 것들:

| 리소스 | 개수 | 비고 |
|---|---|---|
| NAT Gateway | 2 | AZ당 1개. 개발 환경은 `single_nat_gateway = true`로 1개 |
| 인터페이스 VPC 엔드포인트 | 4 | ECR×2, CloudWatch Logs, Secrets Manager |
| ALB | 1 | |
| RDS Multi-AZ | 1 | 스탠바이도 과금된다 |
| ECS Fargate | 최소 3 태스크 | api×2 + ai×1 |
| KMS 고객 관리형 키 | 2 | |

**개발 환경을 만든다면** `single_nat_gateway = true`,
`enable_interface_endpoints = false`, `multi_az = false`,
`min_capacity`는 변수 검증 때문에 2 미만으로 못 내린다 — 개발용 모듈을
따로 두거나 검증 조건을 환경별로 나눠야 한다.

## 아직 없는 것

- **DB 마이그레이션 자동화.** 지금은 수동이다. private 서브넷의 DB에 닿으려면
  일회성 ECS 태스크나 bastion이 필요한데, 어느 쪽이든 "누가 언제 스키마를
  바꿨는가"가 남아야 하므로 대충 만들 수 없다.
- **WAF.** ALB 앞에 붙여야 한다. 규칙을 실측 없이 켜면 정상 요청을 막는다.
- **개발/스테이징 환경.** `envs/prod`만 있다.
- **웹(Next.js) 배포.** 지금 구성에는 API와 AI만 있다.
- **모니터링·알람.** Container Insights는 켰지만 알람이 없다. 무엇을 알람
  걸지는 운영 데이터를 보고 정해야 한다.
- **백업 복원 훈련.** 백업을 켜는 것과 복원되는 것은 다른 문제다.
