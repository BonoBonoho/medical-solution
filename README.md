# MediWork (가칭) — 의료기관 전용 근태·인사 관리 시스템

원티드 스페이스(Wanted Space)류의 범용 HR SaaS가 커버하지 못하는 **의료기관 고유의 근태·인력 관리 문제**를 정면으로 다루는 제품의 기획·설계 저장소입니다.

## 왜 의료 전용인가

범용 근태 SaaS는 "9-6 사무직 + 주 40시간 + 연차"를 전제로 설계되어 있습니다. 병원은 그 전제가 거의 모두 깨집니다.

| 병원의 현실 | 범용 SaaS의 한계 |
|---|---|
| 간호사 3교대(D/E/N), 나이트 전담, 스케줄이 매월 손으로 짜임 | 근무유형이 고정 시프트 1~2개 전제 |
| 당직·온콜은 대기시간과 실근로시간이 분리 | "출근/퇴근" 이벤트 2개만 존재 |
| 전공의는 별도 법(전공의법)의 주당 수련시간 상한 적용 | 주 52시간 로직만 존재 |
| 근태 데이터가 **건강보험 수가 산정 근거**(간호등급, 야간전담 관리료) | 급여 계산까지만 |
| 면허·보수교육·BLS/ACLS 만료가 인증평가 필수 항목 | 자격 관리 개념 없음 |
| 보건업은 근로시간 특례업종(근기법 §59) | 특례 서면합의 처리 불가 |

이 격차가 곧 진입 지점입니다. 특히 **듀티표(근무표) 자동 생성**은 수간호사가 매월 2~5일을 소모하는 업무이고, 여기에 AI를 붙이는 것이 이 제품의 핵심 차별점입니다.

## 문서 구성

| 문서 | 내용 |
|---|---|
| [00. 제품 개요](docs/00-product-overview.md) | 문제 정의, 타겟, 포지셔닝, 성공 지표 |
| [01. 기능 요구사항](docs/01-requirements.md) | 전체 기능 명세와 우선순위 (MoSCoW) |
| [02. 의료 근태 도메인 규칙](docs/02-domain-rules.md) | 근기법·전공의법·수가 연동 등 도메인 규칙 |
| [03. 시스템 아키텍처](docs/03-architecture.md) | 서비스 구성, 기술 스택, 멀티테넌시 |
| [04. 데이터 모델](docs/04-data-model.md) | 핵심 도메인 스키마 (PostgreSQL) |
| [05. API 설계](docs/05-api-design.md) | REST 리소스, 인증, 이벤트 |
| [06. 모바일 출퇴근](docs/06-mobile-attendance.md) | GPS/WiFi/비콘/NFC, 위·변조 방지 |
| [07. 휴가·근태 관리](docs/07-leave-management.md) | 연차 자동 산정, 결재, 대체휴무 |
| [08. AI 기능](docs/08-ai-features.md) | 듀티표 자동 생성, 이상탐지, HR 어시스턴트 |
| [09. PC 사용 통제](docs/09-pc-usage-control.md) | 업무외 사이트 차단, PC-OFF, 프라이버시 |
| [10. 보안·규제 준수](docs/10-security-compliance.md) | 개인정보보호법, 위치정보법, ISMS-P |
| [11. 개발 로드맵](docs/11-roadmap.md) | 단계별 마일스톤, 팀 구성, 리스크 |
| [12. 구현 노트](docs/12-implementation-notes.md) | 구현 현황, 발견된 설계 결함, 확정된 정책 |

## 빠른 요약

**기술 스택 (제안)**
- 백엔드: NestJS(TypeScript) 모듈러 모놀리스 + PostgreSQL 16 + Redis
- AI 서비스: Python FastAPI + OR-Tools CP-SAT(스케줄링) + Claude API(자연어·문서·어시스턴트)
- 웹: Next.js 15 (App Router)
- 모바일: React Native (백그라운드 지오펜싱은 네이티브 모듈)
- PC 통제: Chrome/Edge MV3 확장 + 엔터프라이즈 정책, 옵션으로 Windows 네이티브 에이전트
- 인프라: AWS 서울 리전(ap-northeast-2), ECS Fargate

**MVP 범위 (약 5개월)**
조직·구성원 → 근무유형/스케줄 → 모바일 출퇴근(WiFi+GPS) → 연차 관리 → 근무시간 집계·법정 한도 경보 → 관리자 대시보드

**차별화 기능 (MVP 직후)**
AI 듀티표 생성 → 수가 리포트(간호등급/야간전담) → PC 사용 통제 → 자격·교육 만료 관리

## 현재 구현 상태

```
packages/domain/   ✅  근로시간 산정 · 규칙 엔진 · 연차 · 위치 검증   테스트 140개
apps/api/          ✅  근태 · 근무표 · 휴가 MVP 경로                  테스트 65개
                       PostgreSQL + RLS 테넌트 격리 (인메모리와 동일 e2e 통과)
apps/web/          ✅  근무표 그리드 (키보드 편집 · 실시간 규칙 평가)  테스트 17개
apps/ai/           ✅  근무표 자동 생성 (CP-SAT)                    테스트 51개
apps/mobile/       ⬜  React Native
apps/extension/    ⬜  브라우저 확장 (MV3)
infra/             🟡  Terraform (AWS) — validate 통과, 미적용
```

`pnpm check`는 워크스페이스 전체(TypeScript + Python)를 검사한다.

```bash
pnpm install
pip install -e 'apps/ai[dev]'   # AI 서비스 테스트에 필요

pnpm check      # 전체 타입체크 + 테스트 (인메모리 246개)

# PostgreSQL RLS 테스트까지 함께 돌리려면
export DATABASE_ADMIN_URL=postgres://postgres@localhost:5432/mediwork_test
export DATABASE_URL=postgres://mediwork_app@localhost:5432/mediwork_test
pnpm check      # 273개
```

API 실행 방법과 시드 계정은 [apps/api/README.md](apps/api/README.md),
구현 현황과 설계 변경 이력은 [12. 구현 노트](docs/12-implementation-notes.md) 참고.

## ⚠️ 법률 검토 고지

이 문서의 법령 해석(근로기준법, 전공의법, 위치정보법, 개인정보보호법 등)은 **설계 참고용**입니다. 실제 제품 출시 전 반드시 **공인노무사·개인정보 전문 법무 검토**를 받아야 하며, 특히 다음은 필수입니다.

- 위치정보 수집에 따른 **위치기반서비스사업 신고** 여부 판단
- PC 사용 모니터링의 **근로자 동의·취업규칙 반영·노사협의** 절차
- 근로시간 특례업종 서면합의 양식의 적법성

각 문서에서 검증이 필요한 항목은 `⚖️ 검토필요` 로 표시했습니다.
