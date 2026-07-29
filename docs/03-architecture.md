# 03. 시스템 아키텍처

## 1. 아키텍처 개요

```
                         ┌──────────────────────────────┐
   모바일 (React Native) │                              │
   ├ 출퇴근 체크인       │        CloudFront + WAF      │
   ├ 근무표 조회         │                              │
   ├ 휴가 신청/결재      └──────────────┬───────────────┘
   └ 푸시 알림                          │
                                        │
   웹 (Next.js)          ┌──────────────▼───────────────┐
   ├ 근무표 편집기       │      API Gateway (ALB)       │
   ├ 관리자 대시보드     └──────────────┬───────────────┘
   ├ 인사/휴가 관리                     │
   └ 리포트                 ┌───────────┴───────────┐
                            │                       │
   브라우저 확장     ┌──────▼──────────┐   ┌────────▼─────────┐
   ├ 정책 동기화     │  Core API       │   │  AI Service      │
   ├ URL 판정        │  (NestJS)       │◄──┤  (FastAPI)       │
   └ 사용 리포트     │                 │   │                  │
                     │ ├ identity      │   │ ├ scheduler      │
                     │ ├ org           │   │ │  (OR-Tools)    │
                     │ ├ attendance    │   │ ├ anomaly        │
                     │ ├ roster        │   │ ├ forecast       │
                     │ ├ leave         │   │ └ llm-gateway    │
                     │ ├ ruleengine    │   │    (Claude API)  │
                     │ ├ compliance    │   └──────────────────┘
                     │ ├ pccontrol     │
                     │ └ notification  │
                     └────┬───────┬────┘
                          │       │
              ┌───────────▼──┐ ┌──▼─────────┐ ┌──────────────┐
              │ PostgreSQL   │ │  Redis     │ │  S3          │
              │ (RDS, 암호화)│ │ (캐시/큐)  │ │ (문서/증빙)  │
              └──────────────┘ └────────────┘ └──────────────┘
```

---

## 2. 기술 스택 선택과 근거

### 2.1 백엔드: NestJS (TypeScript) — 모듈러 모놀리스

**선택 이유**
- 웹·모바일·확장까지 전부 TypeScript로 통일 → 도메인 타입(근무유형, 규칙, 집계 결과)을 **패키지로 공유**. 이 제품은 도메인 모델이 복잡하고 클라이언트에서도 같은 계산을 해야 하는 지점(오프라인 집계 미리보기 등)이 있어 타입 공유 이득이 큽니다.
- NestJS의 모듈 시스템이 도메인 경계를 강제하기 좋음.
- 채용 풀이 넓고 초기 개발 속도가 빠름.

**Spring Boot(Kotlin/Java)를 택하지 않은 이유**
- 병원 SI 환경에서는 Java가 안전한 선택이고, 대형 병원 온프레미스 진입 시 유리합니다. 다만 1차 타겟이 중소 병·의원 SaaS이고 초기 속도가 중요하므로 NestJS로 시작합니다.
- **전환 가능성 유지**: 도메인 로직(특히 규칙 엔진, 집계)을 프레임워크 독립적인 순수 함수로 작성해 두면 나중에 이식 비용이 낮아집니다.

**모듈러 모놀리스인 이유**
- 초기에 마이크로서비스로 쪼개면 근태-근무표-휴가 간 트랜잭션 경계에서 고통받습니다. 이 세 도메인은 강하게 결합되어 있습니다.
- 대신 **모듈 간 직접 DB 접근 금지, 인터페이스를 통한 호출만 허용**하여 나중에 분리할 수 있는 상태로 유지합니다.
- AI 서비스만 별도 프로세스로 분리 (Python 생태계 필요 + 리소스 특성이 완전히 다름).

### 2.2 AI 서비스: Python FastAPI

| 구성요소 | 기술 | 이유 |
|---|---|---|
| 근무표 최적화 | **OR-Tools CP-SAT** | 간호사 스케줄링은 전형적인 제약 만족·최적화 문제. LLM으로 직접 풀면 안 됨(제약 위반이 반드시 발생). CP-SAT는 이 문제에 검증된 도구. |
| 자연어 제약 파싱 | **Claude API** | "이번달 김간호사 나이트 빼고" → 구조화 제약 JSON. LLM이 잘하는 일. |
| 이상탐지 | scikit-learn / 규칙 기반 | 초기엔 규칙 기반으로 충분. 데이터 쌓인 뒤 ML. |
| 수요예측 | Prophet / LightGBM | 후순위. |
| HR 어시스턴트 | Claude API + pgvector | 취업규칙 RAG. |

**핵심 설계 원칙: LLM과 최적화 엔진의 역할을 명확히 분리합니다.**
- LLM은 **입력을 이해**하고 **결과를 설명**한다.
- 제약을 만족하는 스케줄을 **생성하는 것은 CP-SAT**가 한다.
- LLM에게 근무표를 직접 생성하게 하면 그럴듯하지만 규칙을 위반한 표가 나옵니다. 병원에서 이건 치명적입니다.

상세는 [08. AI 기능](08-ai-features.md) 참고.

### 2.3 프론트엔드: Next.js 15 (App Router)

- 관리자 웹. SSR로 초기 로딩 성능 확보.
- **근무표 편집기는 예외적으로 고성능 클라이언트 컴포넌트**로 구현. 200명 × 31일 = 6,200셀 그리드는 일반 React 렌더링으로 감당 안 됨. 가상 스크롤 + Canvas 또는 셀 단위 메모이제이션 필요. 이 컴포넌트가 제품에서 기술적으로 가장 어려운 UI입니다.
- 상태관리: TanStack Query (서버 상태) + Zustand (편집기 로컬 상태).

### 2.4 모바일: React Native

- **가장 중요한 요구사항이 백그라운드 위치·WiFi 접근**이라, 어떤 크로스플랫폼을 택해도 네이티브 모듈이 필요합니다.
- React Native를 택하는 이유: TypeScript 통일, 도메인 타입 공유, 커뮤니티의 지오펜싱 라이브러리 성숙도.
- 네이티브 모듈로 직접 구현할 부분:
  - iOS: `CoreLocation` 지오펜싱, `NEHotspotNetwork` (WiFi SSID/BSSID — Entitlement 필요), `DeviceCheck`/`App Attest`
  - Android: `Geofencing API`, `WifiManager`, `Play Integrity API`
- Flutter도 유효한 선택이나, 웹/백엔드와의 타입 공유 이득이 사라집니다.

### 2.5 데이터베이스: PostgreSQL 16

- 트랜잭션 정합성이 핵심(근태 기록, 휴가 잔액). NoSQL은 부적합.
- `pgvector`로 RAG 임베딩까지 한 DB에서 처리 (초기 운영 단순화).
- 파티셔닝: `attendance_record`, `audit_log`는 월 단위 파티션.
- Redis: 세션, 정책 캐시(브라우저 확장이 자주 조회), 작업 큐(BullMQ).

### 2.6 인프라: AWS 서울 리전 (ap-northeast-2)

- **국내 리전 필수.** 개인정보 국외 이전은 별도 동의·고지 부담이 크고, 병원 고객이 거부합니다.
- ECS Fargate (EKS는 초기 운영 부담 과다). 트래픽이 커지면 EKS 전환 검토.
- RDS PostgreSQL Multi-AZ, 자동 백업 + PITR.
- 대안: NHN Cloud / NCP — 공공·의료 부문 조달 시 국내 CSP 요구가 있을 수 있음. 인프라를 Terraform으로 관리해 이식 가능성 확보.

---

## 3. 멀티테넌시 전략

### 3.1 선택: 공유 스키마 + Row Level Security

```sql
-- 모든 테넌트 데이터 테이블
CREATE TABLE attendance_record (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  ...
);

ALTER TABLE attendance_record ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON attendance_record
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

- 요청마다 `SET LOCAL app.tenant_id` 를 설정하는 미들웨어를 두고, **애플리케이션 코드가 WHERE 절을 빠뜨려도 데이터가 새지 않도록** DB 레벨에서 보장합니다.
- 실수 한 번이 다른 병원의 인사 데이터 노출로 이어지는 도메인이므로, 애플리케이션 레벨 필터링만 믿지 않습니다.

### 3.2 전용 인스턴스 옵션 (대형 고객)

- 대형 병원은 "우리 데이터가 다른 병원과 같은 DB에 있다"를 수용하지 않는 경우가 있습니다.
- 같은 코드베이스를 **별도 VPC + 별도 RDS**에 배포하는 옵션을 제공. Terraform 모듈로 표준화.
- 단, **릴리스 파이프라인이 두 벌이 되므로** 비용을 명확히 인지하고 계약 규모가 받쳐줄 때만 제공합니다.

---

## 4. 모듈 구성

| 모듈 | 책임 | 주요 의존 |
|---|---|---|
| `identity` | 인증, 세션, 기기 바인딩, RBAC | — |
| `org` | 테넌트, 사업장, 부서, 구성원, 발령 | identity |
| `credential` | 면허·자격·교육 이수 관리 | org |
| `roster` | 근무유형, 근무표, 배정, 스왑 | org, ruleengine |
| `attendance` | 출퇴근 기록, 위치 검증, 수정 요청 | org, roster |
| `worktime` | 근로시간 집계 (계획/실적) | attendance, roster |
| `leave` | 휴가 정책, 잔액, 신청, 결재 | org, worktime |
| `approval` | 범용 결재 엔진 (휴가/야근/수정요청 공통) | org |
| `ruleengine` | 규칙 평가, 위반 산출 | — (순수 로직) |
| `compliance` | 법정한도 경보, 수가 리포트, 감독 대응 자료 | worktime, ruleengine |
| `pccontrol` | 차단 정책, 사용 로그, 리포트 | org, attendance |
| `notification` | 푸시, 알림톡, 이메일 | — |
| `audit` | 감사 로그 (모든 모듈이 기록) | — |
| `integration` | Export, 외부 시스템 연동, SSO | — |

### 4.1 모듈 간 규칙

1. **DB 직접 접근 금지.** 다른 모듈의 테이블을 조인하지 않음. 필요하면 인터페이스를 통해 조회.
2. `ruleengine`은 **부수효과 없는 순수 함수**로 유지. 테스트가 쉬워야 하고, 나중에 클라이언트에서도 실행할 수 있어야 함(근무표 편집기 실시간 검증).
3. **`approval` 모듈을 처음부터 범용으로 설계.** 휴가 결재, 야근 승인, 근태 수정 승인, PC 차단 해제 요청이 모두 같은 결재 흐름입니다. 각각 따로 만들면 4벌의 중복 코드가 생깁니다.

---

## 5. 핵심 데이터 흐름

### 5.1 출퇴근 기록

```
모바일 앱
  │ ① 위치 수집 (GPS + WiFi BSSID 스캔)
  │ ② 기기 무결성 토큰 획득 (Play Integrity / App Attest)
  ▼
POST /attendance/check-in
  { type, capturedAt, gps{lat,lng,accuracy,isMock},
    wifi[{bssid,rssi}], deviceId, integrityToken, clientNonce }
  │
  ▼ attendance 모듈
  ├─ ③ 기기 무결성 검증 (실패 → 거부)
  ├─ ④ 기기 바인딩 확인 (등록된 기기인가)
  ├─ ⑤ 위치 검증
  │     WiFi BSSID 매칭 → 확정 (신뢰도 HIGH)
  │     실패 시 GPS 지오펜스 → 확정 (신뢰도 MEDIUM)
  │     둘 다 실패 → 기록하되 PENDING_REVIEW 상태
  ├─ ⑥ 중복 방지 (clientNonce로 멱등성)
  ├─ ⑦ 근무표 대조 → 계획 대비 지각/조퇴 판정
  └─ ⑧ AttendanceRecord 저장 (원본 불변)
  │
  ▼ 이벤트 발행: AttendanceRecorded
  ├─ worktime  : 집계 갱신
  ├─ compliance: 한도 초과 여부 검사 → 필요시 경보
  └─ pccontrol : 근무 상태 변경 → 정책 전환
```

**설계 포인트**
- `clientNonce`로 멱등성 확보. 지하철에서 재시도로 중복 체크인되는 사고를 막습니다.
- 검증 실패해도 **기록은 남깁니다.** 거부하고 버리면 직원은 출근했는데 기록이 없는 상태가 되고, 그건 병원 책임 문제가 됩니다. `PENDING_REVIEW`로 남기고 관리자가 판단하게 합니다.
- 원본은 불변. 수정은 `AttendanceCorrection` 레코드를 추가하고 `effectiveRecord`가 최신을 가리키게 합니다.

### 5.2 AI 근무표 생성

```
관리자: 근무표 생성 요청 (대상 병동, 기간, 자연어 요청사항)
  │
  ▼ Core API: 컨텍스트 수집
  ├─ 대상 구성원 + 고용형태 + 개인 제약
  ├─ 오프 신청 목록
  ├─ 확정된 휴가
  ├─ 병동 최소 인력 설정
  ├─ 적용 RuleSet (법정 제약)
  └─ 직전 월 근무표 (경계 조건: 말일 나이트 → 다음달 1일 제약)
  │
  ▼ POST → AI Service /schedule/generate
  ├─ ① LLM: 자연어 요청 → 구조화 제약 (검증 스키마 강제)
  ├─ ② 제약 병합 및 충돌 검사 → 충돌 시 즉시 반환 (풀지 않음)
  ├─ ③ CP-SAT 모델 구성 (하드/소프트 제약)
  ├─ ④ 해 탐색 (타임박스 60초, 중간 해 스트리밍)
  └─ ⑤ LLM: 결과 요약 및 미충족 소프트 제약 설명
  │
  ▼ 결과: 근무표 초안 + 설명 + 미충족 항목
  │
  ▼ 관리자 검토 → 수정 → 확정
  └─ 수정 내역을 피드백으로 축적 (제약 학습)
```

**타임박스가 중요합니다.** 최적해를 찾을 때까지 기다리면 몇 시간이 걸릴 수 있습니다. 60초 안에 "충분히 좋은 해"를 주고, 관리자가 수정하는 편이 훨씬 낫습니다.

---

## 6. 이벤트 아키텍처

초기에는 **인프로세스 이벤트 버스**(NestJS EventEmitter)로 시작합니다. Kafka는 과합니다.

| 이벤트 | 발행 | 구독 |
|---|---|---|
| `AttendanceRecorded` | attendance | worktime, compliance, pccontrol |
| `RosterPublished` | roster | notification, worktime |
| `LeaveApproved` | leave | roster, worktime, notification |
| `WorktimeAggregated` | worktime | compliance |
| `ComplianceViolationDetected` | compliance | notification |
| `MemberAssignmentChanged` | org | roster, ruleengine(캐시무효화) |

**단, 이벤트 처리 실패가 데이터 불일치로 이어지면 안 되는 것**(휴가 승인 → 근무표 반영)은 이벤트가 아니라 **같은 트랜잭션 내 직접 호출**로 처리합니다. 이벤트는 알림·집계처럼 결과적 일관성이 허용되는 곳에만 씁니다.

---

## 7. 오프라인·복원력

### 7.1 모바일 오프라인

병원 지하나 일부 병동은 통신이 불안정합니다.

```
체크인 시도
  ├─ 온라인: 즉시 전송 → 서버 확정 → UI "기록 완료"
  └─ 오프라인: 로컬 큐 저장 → UI "기록 대기중 (n건)"
                 ├─ 로컬 서명 (기기 키로 서명하여 사후 조작 방지)
                 ├─ 단조 증가 시퀀스 번호 (순서 및 누락 탐지)
                 └─ 네트워크 복구 시 순차 전송
```

- **UI에서 "기록 완료"와 "대기중"을 명확히 구분**해야 합니다. 대기중을 완료로 표시하면 직원은 기록됐다고 믿었는데 안 된 상황이 생깁니다.
- 오프라인 기록은 서버 도착 시각과 캡처 시각의 차이가 큽니다. 지연이 임계값(예: 4시간)을 넘으면 `PENDING_REVIEW`로 처리.

### 7.2 장애 시 대비

| 장애 | 대응 |
|---|---|
| API 전체 장애 | 모바일 오프라인 큐로 흡수. 상태 페이지 공지. |
| AI 서비스 장애 | 근무표 수동 편집은 정상 동작. AI는 부가 기능이므로 코어를 막지 않음. |
| 위치 검증 불가 | 기록은 받되 `PENDING_REVIEW`. 절대 거부하지 않음. |
| DB 장애 | Multi-AZ 자동 failover. RPO 5분, RTO 15분 목표. |

---

## 8. 개발·배포

### 8.1 저장소 구조 (모노레포, pnpm workspace + Turborepo)

```
medical-solution/
├── apps/
│   ├── api/              # NestJS Core API
│   ├── web/              # Next.js 관리자 웹
│   ├── mobile/           # React Native
│   ├── extension/        # 브라우저 확장 (MV3)
│   └── ai/               # Python FastAPI (별도 빌드)
├── packages/
│   ├── domain/           # 도메인 타입 + 순수 로직 (규칙 엔진 포함)
│   ├── api-client/       # OpenAPI 생성 클라이언트
│   ├── ui/               # 공유 UI 컴포넌트
│   └── config/           # ESLint/TS 설정
├── infra/                # Terraform
└── docs/
```

`packages/domain`이 핵심입니다. 근로시간 계산, 연차 산정, 규칙 평가가 여기 있고 서버·웹·모바일이 모두 이걸 씁니다. **계산 로직이 세 벌로 갈라지는 것이 이 도메인에서 가장 흔한 사고**입니다.

### 8.2 환경

| 환경 | 용도 |
|---|---|
| local | Docker Compose (Postgres, Redis, LocalStack) |
| dev | 개발 통합, 자동 배포 |
| staging | **실 데이터 형태의 익명화 데이터로 검증.** 병원 도메인은 엣지케이스가 많아 합성 데이터로는 안 잡힘. |
| prod | 운영 |

### 8.3 테스트 전략

| 레벨 | 대상 | 비중 |
|---|---|---|
| 단위 | 규칙 엔진, 근로시간 계산, 연차 산정 | **가장 두껍게.** 여기 버그는 급여 오류로 직결. |
| 통합 | API + DB (Testcontainers) | 중간 |
| E2E | 핵심 시나리오 (출퇴근, 근무표 확정, 휴가 결재) | 얇게 |
| 시나리오 | **실제 병원 케이스 기반 골든 테스트** | 별도 트랙 |

**골든 테스트**: 실제 병원의 한 달 근무표와 근태 기록을 익명화해 고정 픽스처로 만들고, 집계 결과를 스냅샷으로 검증합니다. 리팩터링 시 계산 결과가 바뀌지 않음을 보장하는 유일한 방법입니다.
