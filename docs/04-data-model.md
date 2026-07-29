# 04. 데이터 모델

PostgreSQL 16 기준. 모든 테넌트 데이터 테이블은 `tenant_id`를 가지며 RLS가 적용됩니다.

공통 컬럼(생략 표기): `created_at`, `updated_at`, `created_by`, `updated_by`.

---

## 1. 조직·구성원

```sql
CREATE TABLE tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  biz_reg_no      text,                    -- 사업자등록번호 (암호화)
  plan            text NOT NULL,           -- BASIC | PRO | ENTERPRISE
  status          text NOT NULL DEFAULT 'ACTIVE',
  settings        jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE worksite (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  name                  text NOT NULL,
  address               text,
  -- 규칙 적용을 좌우하는 핵심 필드
  employee_count_tier   text NOT NULL,     -- UNDER_5 | FROM_5 | FROM_50 | FROM_300
  industry_code         text,              -- 보건업 여부 판정
  timezone              text NOT NULL DEFAULT 'Asia/Seoul',
  -- 병상 수 (수가 리포트용)
  licensed_beds         int,
  UNIQUE (tenant_id, name)
);

-- 지오펜스: 사업장 하나에 여러 개 가능 (본관/별관/주차장)
CREATE TABLE geofence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  worksite_id   uuid NOT NULL REFERENCES worksite(id),
  name          text NOT NULL,
  center        geography(Point, 4326) NOT NULL,   -- PostGIS
  radius_m      int NOT NULL CHECK (radius_m BETWEEN 20 AND 2000),
  is_active     boolean NOT NULL DEFAULT true
);

-- WiFi AP 화이트리스트 (실내에서 GPS보다 신뢰도 높음)
CREATE TABLE worksite_wifi_ap (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  worksite_id   uuid NOT NULL REFERENCES worksite(id),
  bssid         macaddr NOT NULL,          -- BSSID는 SSID보다 위조가 어려움
  ssid          text,
  label         text,                      -- "3층 간호사실"
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, bssid)
);

CREATE TABLE department (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  worksite_id   uuid NOT NULL REFERENCES worksite(id),
  parent_id     uuid REFERENCES department(id),
  name          text NOT NULL,
  dept_type     text NOT NULL,             -- CLINICAL_DEPT | WARD | ADMIN | FACILITY
  path          ltree NOT NULL,            -- 조직 트리 조회 및 권한 스코프에 사용
  -- 병동인 경우
  ward_beds     int
);
CREATE INDEX ON department USING gist (path);
```

`path`에 `ltree`를 쓰는 이유: RBAC 권한 스코프가 "이 부서와 그 하위 전체"로 정의되는데, 재귀 CTE보다 `path <@ 'hospital.nursing'` 조회가 훨씬 빠르고 단순합니다.

```sql
CREATE TABLE member (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  employee_no       text NOT NULL,
  name              text NOT NULL,
  -- 고유식별정보는 별도 암호화 컬럼 + 검색용 해시
  rrn_encrypted     bytea,                 -- 주민등록번호 (AES-256, 별도 KMS 키)
  rrn_hash          text,                  -- 중복 확인용 (HMAC)
  phone_encrypted   bytea,
  email             text,
  hire_date         date NOT NULL,
  resign_date       date,
  -- 규칙 적용의 핵심 축
  job_family        text NOT NULL,         -- DOCTOR | RESIDENT | NURSE | NURSE_AIDE
                                           -- | MED_TECH | PHARMACIST | ADMIN | FACILITY
  employment_type   text NOT NULL,         -- REGULAR | CONTRACT | PART_TIME
                                           -- | TEMPORARY | CONTRACT_PROF
  status            text NOT NULL,         -- ACTIVE | ON_LEAVE | RESIGNED
  UNIQUE (tenant_id, employee_no)
);

-- 소속 이력. 현재 소속이 아니라 "시점별 소속"이 필요합니다.
-- 3월 근무표를 4월에 조회할 때, 3월 당시 소속으로 봐야 합니다.
CREATE TABLE member_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  department_id     uuid NOT NULL REFERENCES department(id),
  worksite_id       uuid NOT NULL REFERENCES worksite(id),
  position          text,                  -- 직급
  duty              text,                  -- 직책 (수간호사 등)
  is_primary        boolean NOT NULL DEFAULT true,
  effective_from    date NOT NULL,
  effective_to      date,                  -- NULL = 현재
  reason            text                   -- 발령 사유
);
CREATE INDEX ON member_assignment (tenant_id, member_id, effective_from DESC);
```

**`member_assignment`가 이력 테이블인 것이 중요합니다.** 부서 이동을 `member.department_id` 업데이트로 처리하면 과거 근무표·집계가 전부 틀어집니다. 인사 시스템에서 가장 흔한 설계 실수입니다.

---

## 2. 자격·교육

```sql
CREATE TABLE credential_type (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,                  -- NULL = 시스템 기본 제공
  code              text NOT NULL,         -- NURSE_LICENSE | BLS | ACLS | ...
  name              text NOT NULL,
  category          text NOT NULL,         -- LICENSE | CERTIFICATION
                                           -- | MANDATORY_EDU | CONTINUING_EDU
  renewal_months    int,                   -- 갱신 주기 (NULL = 무기한)
  alert_days        int[] DEFAULT '{90,60,30,7}'
);

CREATE TABLE member_credential (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  credential_type_id uuid NOT NULL REFERENCES credential_type(id),
  credential_no     text,
  issued_at         date,
  expires_at        date,
  issuer            text,
  file_key          text,                  -- S3 key
  status            text NOT NULL          -- VALID | EXPIRING | EXPIRED | PENDING
);
CREATE INDEX ON member_credential (tenant_id, expires_at)
  WHERE status IN ('VALID', 'EXPIRING');

-- 보수교육 평점 누적
CREATE TABLE education_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  credential_type_id uuid REFERENCES credential_type(id),
  title             text NOT NULL,
  completed_at      date NOT NULL,
  credit_points     numeric(5,2),
  target_year       int NOT NULL,
  file_key          text
);
```

---

## 3. 근무유형·근무표

```sql
CREATE TABLE shift_type (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  worksite_id       uuid REFERENCES worksite(id),   -- NULL = 전사 공통
  code              text NOT NULL,         -- D | E | N | ND | DUTY | ONCALL | O | A
  name              text NOT NULL,
  color             text,                  -- 근무표 그리드 표시 색
  category          text NOT NULL,         -- WORK | OFF | LEAVE | DUTY | ONCALL

  -- 시간 정의. 종료가 시작보다 이르면 익일로 해석.
  start_time        time,
  end_time          time,
  crosses_midnight  boolean GENERATED ALWAYS AS (end_time < start_time) STORED,
  break_minutes     int NOT NULL DEFAULT 0,

  -- 근로시간 산정
  paid_minutes      int,                   -- 유급 처리 시간 (NULL = 실시간 계산)
  counts_as_work    boolean NOT NULL DEFAULT true,
  duty_mode         text,                  -- FULL_WORK | CALL_ONLY | POLICY_RATIO
  duty_ratio        numeric(4,3),          -- duty_mode=POLICY_RATIO일 때

  -- 스케줄링 제약용 메타
  is_night          boolean NOT NULL DEFAULT false,
  requires_credential_ids uuid[],          -- 이 근무에 필요한 자격
  sort_order        int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, worksite_id, code)
);
```

`paid_minutes`를 NULL 허용으로 둔 이유: 대부분은 `end - start - break`로 계산되지만, "당직은 실제 8시간이어도 4시간만 유급"처럼 노사합의로 정해진 경우가 있습니다. 계산식으로 표현 불가능한 것은 값으로 받습니다.

```sql
CREATE TABLE roster (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  department_id     uuid NOT NULL REFERENCES department(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            text NOT NULL,         -- DRAFT | REVIEW | PUBLISHED | CLOSED
  version           int NOT NULL DEFAULT 1,
  published_at      timestamptz,
  published_by      uuid,
  -- AI 생성 관련
  generation_id     uuid,                  -- schedule_generation 참조
  UNIQUE (tenant_id, department_id, period_start, version)
);

CREATE TABLE roster_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  roster_id         uuid NOT NULL REFERENCES roster(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id),
  work_date         date NOT NULL,
  shift_type_id     uuid NOT NULL REFERENCES shift_type(id),
  -- 개별 조정 (기본 시간과 다르게 배정할 때)
  start_override    time,
  end_override      time,
  note              text,
  source            text NOT NULL DEFAULT 'MANUAL',  -- MANUAL | AI | PATTERN | SWAP
  UNIQUE (tenant_id, roster_id, member_id, work_date)
);
CREATE INDEX ON roster_assignment (tenant_id, member_id, work_date);
```

`UNIQUE (roster_id, member_id, work_date)`는 하루 한 근무를 전제합니다. 당직이 정규 근무에 이어지는 경우를 별도 행으로 표현해야 한다면 이 제약을 풀고 `sequence` 컬럼을 추가해야 합니다. **MVP에서는 "정규+당직"을 하나의 합성 shift_type으로 처리**하고, 필요해지면 확장합니다.

```sql
-- 희망휴무 신청
CREATE TABLE off_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  target_month      date NOT NULL,         -- 대상 월의 1일
  request_date      date NOT NULL,
  preference        text NOT NULL,         -- MUST_OFF | PREFER_OFF | PREFER_SHIFT
  preferred_shift_type_id uuid REFERENCES shift_type(id),
  reason            text,
  priority          int NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'REQUESTED',
  UNIQUE (tenant_id, member_id, request_date)
);

-- 근무 교환
CREATE TABLE shift_swap (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  requester_id      uuid NOT NULL REFERENCES member(id),
  target_id         uuid NOT NULL REFERENCES member(id),
  requester_assignment_id uuid NOT NULL REFERENCES roster_assignment(id),
  target_assignment_id    uuid REFERENCES roster_assignment(id),  -- NULL = 단순 양도
  status            text NOT NULL,   -- REQUESTED | PEER_ACCEPTED | PEER_REJECTED
                                     -- | APPROVED | REJECTED | CANCELLED
  peer_responded_at timestamptz,
  approved_by       uuid,
  rule_check_result jsonb            -- 교환 시점 규칙 검증 결과 보존
);
```

---

## 4. 출퇴근 기록

```sql
CREATE TABLE attendance_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  work_date         date NOT NULL,         -- 근무일 (야간근무는 시작일 기준)
  record_type       text NOT NULL,         -- CHECK_IN | CHECK_OUT
                                           -- | BREAK_START | BREAK_END
                                           -- | CALL_START | CALL_END
  captured_at       timestamptz NOT NULL,  -- 기기에서 기록한 시각
  received_at       timestamptz NOT NULL DEFAULT now(),  -- 서버 도착 시각

  -- 검증 결과
  verification      text NOT NULL,         -- VERIFIED | PENDING_REVIEW | REJECTED
  verify_method     text,                  -- WIFI | GPS | BEACON | NFC | IP | KIOSK | MANUAL
  confidence        text,                  -- HIGH | MEDIUM | LOW
  worksite_id       uuid REFERENCES worksite(id),

  -- 원시 증거 (분쟁 대응 및 이상탐지용)
  evidence          jsonb NOT NULL DEFAULT '{}',
  -- { gps: {lat, lng, accuracy, isMock}, wifi: [{bssid, rssi}],
  --   beacon: [...], ip: "...", deviceId: "...", integrity: {...} }

  source            text NOT NULL,         -- MOBILE | WEB | KIOSK | ADMIN | IMPORT
  device_id         uuid REFERENCES member_device(id),
  client_nonce      text,                  -- 멱등성 키
  offline_queued    boolean NOT NULL DEFAULT false,
  sequence_no       bigint,                -- 오프라인 큐 순서

  is_superseded     boolean NOT NULL DEFAULT false  -- 수정으로 대체되었는가
) PARTITION BY RANGE (work_date);

CREATE UNIQUE INDEX ON attendance_record (tenant_id, member_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
CREATE INDEX ON attendance_record (tenant_id, member_id, work_date, captured_at);
```

**핵심 설계: 원본은 절대 UPDATE하지 않습니다.** 수정이 필요하면 새 레코드를 만들고 원본에 `is_superseded = true`를 표시합니다. 근태 기록은 분쟁 시 증거가 되므로 원본 보존이 필수입니다.

```sql
CREATE TABLE attendance_correction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL,
  original_record_id uuid REFERENCES attendance_record(id),  -- NULL = 누락 보완
  corrected_record_id uuid REFERENCES attendance_record(id),
  work_date         date NOT NULL,
  reason_code       text NOT NULL,   -- FORGOT | DEVICE_ISSUE | LOCATION_FAIL
                                     -- | SYSTEM_ERROR | OTHER
  reason_text       text NOT NULL,
  requested_by      uuid NOT NULL,
  approval_id       uuid,            -- approval 모듈 참조
  status            text NOT NULL
);

CREATE TABLE member_device (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  platform          text NOT NULL,         -- IOS | ANDROID
  device_name       text,
  device_fingerprint text NOT NULL,
  public_key        text,                  -- 오프라인 기록 서명 검증용
  status            text NOT NULL,         -- ACTIVE | REVOKED | PENDING
  registered_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz,
  UNIQUE (tenant_id, member_id, device_fingerprint)
);
```

기기 바인딩은 **1인 1기기 원칙**으로 시작합니다. 기기 변경은 관리자 승인. 대리 출근의 가장 흔한 수법이 "동료에게 계정 공유"인데, 기기 바인딩이 이걸 상당 부분 막습니다.

---

## 5. 근로시간 집계

```sql
-- 일별 집계 (계획/실적 각각)
CREATE TABLE worktime_daily (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  work_date         date NOT NULL,
  basis             text NOT NULL,         -- PLANNED | ACTUAL

  scheduled_start   timestamptz,
  scheduled_end     timestamptz,
  actual_start      timestamptz,
  actual_end        timestamptz,

  -- 분 단위 집계
  work_minutes          int NOT NULL DEFAULT 0,   -- 소정근로
  overtime_minutes      int NOT NULL DEFAULT 0,   -- 연장
  night_minutes         int NOT NULL DEFAULT 0,   -- 야간(22~06)
  holiday_minutes       int NOT NULL DEFAULT 0,   -- 휴일근로
  holiday_ot_minutes    int NOT NULL DEFAULT 0,   -- 휴일 8시간 초과분
  break_minutes         int NOT NULL DEFAULT 0,
  -- 전공의 전용
  training_minutes      int,                      -- 수련시간
  education_minutes     int,                      -- 교육 목적 시간

  -- 판정
  is_late           boolean NOT NULL DEFAULT false,
  late_minutes      int NOT NULL DEFAULT 0,
  is_early_leave    boolean NOT NULL DEFAULT false,
  is_absent         boolean NOT NULL DEFAULT false,

  rule_set_version  text,                  -- 어떤 규칙으로 계산했는지
  computed_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, member_id, work_date, basis)
) PARTITION BY RANGE (work_date);
```

집계 테이블을 두는 이유: 매번 원시 기록에서 재계산하면 월 마감(1,000명 × 31일)이 감당 안 됩니다. 대신 **원시 데이터가 바뀌면 해당 일자 집계를 무효화하고 재계산**하는 파이프라인이 필요합니다.

`rule_set_version`을 저장하는 이유: 나중에 "왜 이 값이 나왔나"를 재현할 수 있어야 합니다.

```sql
-- 주별 집계 (52시간, 전공의 상한 검사용)
CREATE TABLE worktime_weekly (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL,
  week_start        date NOT NULL,         -- 월요일
  basis             text NOT NULL,
  total_minutes     int NOT NULL DEFAULT 0,
  overtime_minutes  int NOT NULL DEFAULT 0,
  night_minutes     int NOT NULL DEFAULT 0,
  -- 전공의 4주 평균 산정용
  training_minutes  int,
  duty_count        int NOT NULL DEFAULT 0,
  off_days          int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, member_id, week_start, basis)
);
```

---

## 6. 휴가

```sql
CREATE TABLE leave_type (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,                  -- NULL = 시스템 기본
  code              text NOT NULL,         -- ANNUAL | HALF_DAY | SICK | MATERNITY ...
  name              text NOT NULL,
  is_paid           boolean NOT NULL,
  deducts_from_balance boolean NOT NULL,   -- 연차 잔액 차감 여부
  balance_source    text,                  -- ANNUAL | COMP_LEAVE (차감 대상)
  unit              text NOT NULL,         -- DAY | HALF_DAY | QUARTER_DAY | HOUR
  max_days_per_year numeric(5,2),
  requires_evidence boolean NOT NULL DEFAULT false,
  gender_restriction text,                 -- 보건휴가 등
  min_notice_days   int,
  approval_flow_id  uuid,
  is_active         boolean NOT NULL DEFAULT true
);

-- 연차 부여 원장. 발생 건별로 행을 만들고 소멸까지 추적합니다.
CREATE TABLE leave_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  balance_source    text NOT NULL,         -- ANNUAL | COMP_LEAVE
  grant_reason      text NOT NULL,         -- BASE_15 | MONTHLY_1 | TENURE_EXTRA
                                           -- | COMPENSATORY | MANUAL_ADJUST
  granted_days      numeric(5,2) NOT NULL,
  used_days         numeric(5,2) NOT NULL DEFAULT 0,
  expired_days      numeric(5,2) NOT NULL DEFAULT 0,
  effective_from    date NOT NULL,
  expires_at        date NOT NULL,
  grant_basis       jsonb,                 -- 산정 근거 (출근율, 재직기간 등)
  note              text
);
CREATE INDEX ON leave_grant (tenant_id, member_id, expires_at);
```

**잔액을 단일 숫자 컬럼으로 두지 않고 부여 건별 원장으로 관리하는 이유:**
1. 연차는 발생일마다 소멸일이 다릅니다. 선입선출 차감이 필요합니다.
2. 사용촉진·미사용수당 정산 시 "어느 연차가 언제 소멸했는지"를 증빙해야 합니다.
3. 단일 잔액 컬럼은 동시성 문제와 감사 추적 불가 문제를 동시에 일으킵니다.

```sql
CREATE TABLE leave_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  leave_type_id     uuid NOT NULL REFERENCES leave_type(id),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  days_count        numeric(5,2) NOT NULL,
  hours_count       numeric(6,2),
  reason            text,
  evidence_file_key text,
  status            text NOT NULL,   -- DRAFT | PENDING | APPROVED | REJECTED
                                     -- | CANCELLED | CANCEL_PENDING
  approval_id       uuid,
  applied_at        timestamptz
);

-- 차감 내역 (어느 grant에서 얼마를 썼는지)
CREATE TABLE leave_deduction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  leave_request_id  uuid NOT NULL REFERENCES leave_request(id),
  leave_grant_id    uuid NOT NULL REFERENCES leave_grant(id),
  days              numeric(5,2) NOT NULL
);

-- 연차 사용촉진 (근기법 §61 절차 증빙)
CREATE TABLE leave_promotion (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL,
  target_year       int NOT NULL,
  stage             text NOT NULL,         -- FIRST_NOTICE | MEMBER_PLAN | DESIGNATION
  remaining_days    numeric(5,2) NOT NULL,
  notified_at       timestamptz NOT NULL,
  notified_method   text NOT NULL,         -- SYSTEM | EMAIL | DOCUMENT
  member_responded_at timestamptz,
  designated_dates  date[],
  evidence_file_key text
);
```

---

## 7. 규칙 엔진

```sql
CREATE TABLE rule_set (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid,                  -- NULL = 시스템 기본 규칙
  name              text NOT NULL,
  -- 적용 스코프 (NULL = 제한 없음). 좁을수록 우선.
  worksite_id       uuid REFERENCES worksite(id),
  job_family        text,
  employment_type   text,
  effective_from    date NOT NULL,
  effective_to      date,
  priority          int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true
);

CREATE TABLE rule_definition (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id       uuid NOT NULL REFERENCES rule_set(id) ON DELETE CASCADE,
  code              text NOT NULL,         -- WEEKLY_OT_LIMIT | MIN_REST_BETWEEN_SHIFTS ...
  params            jsonb NOT NULL,
  severity          text NOT NULL,         -- BLOCK | WARN | INFO
  legal_basis       text,
  enabled           boolean NOT NULL DEFAULT true,
  UNIQUE (rule_set_id, code)
);

-- 근로시간 특례 등 서면합의 관리
CREATE TABLE labor_agreement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  worksite_id       uuid NOT NULL REFERENCES worksite(id),
  agreement_type    text NOT NULL,   -- SPECIAL_EXCEPTION_59 | COMP_LEAVE_57
                                     -- | FLEXIBLE_51 | SELECTIVE_52
  title             text NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date NOT NULL,   -- 만료 시 관련 규칙 자동 비활성
  rep_name          text,            -- 근로자대표
  file_key          text NOT NULL,   -- 합의서 원본
  params            jsonb            -- 정산기간 등
);

-- 위반 기록
CREATE TABLE rule_violation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid REFERENCES member(id),
  rule_code         text NOT NULL,
  severity          text NOT NULL,
  basis             text NOT NULL,         -- PLANNED | ACTUAL
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  detail            jsonb NOT NULL,
  status            text NOT NULL,   -- OPEN | ACKNOWLEDGED | JUSTIFIED | RESOLVED
  -- 강행 시 사유 기록
  override_reason   text,
  override_by       uuid,
  override_at       timestamptz,
  detected_at       timestamptz NOT NULL DEFAULT now()
);
```

`override_reason`이 이 테이블의 핵심입니다. [02. 도메인 규칙 §7.2](02-domain-rules.md#72-위반-처리-원칙)에서 설명한 대로, 위반을 막는 게 아니라 **기록하는 것**이 목적입니다.

---

## 8. 결재 (범용)

```sql
CREATE TABLE approval_flow (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  target_type       text NOT NULL,   -- LEAVE | OVERTIME | ATTENDANCE_CORRECTION
                                     -- | SHIFT_SWAP | PC_UNBLOCK
  steps             jsonb NOT NULL
  -- [{ order:1, approverType:'DIRECT_MANAGER' },
  --  { order:2, approverType:'DEPT_HEAD', condition:{days:{gte:3}} },
  --  { order:3, approverType:'ROLE', roleCode:'HR_MANAGER' }]
);

CREATE TABLE approval (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  flow_id           uuid NOT NULL REFERENCES approval_flow(id),
  target_type       text NOT NULL,
  target_id         uuid NOT NULL,
  requester_id      uuid NOT NULL REFERENCES member(id),
  current_step      int NOT NULL DEFAULT 1,
  status            text NOT NULL,   -- PENDING | APPROVED | REJECTED | CANCELLED
  completed_at      timestamptz
);

CREATE TABLE approval_step (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id       uuid NOT NULL REFERENCES approval(id) ON DELETE CASCADE,
  step_order        int NOT NULL,
  approver_id       uuid REFERENCES member(id),
  delegated_from    uuid REFERENCES member(id),   -- 대결
  action            text,            -- APPROVE | REJECT | HOLD
  comment           text,
  acted_at          timestamptz
);
```

---

## 9. PC 사용 통제

```sql
CREATE TABLE pc_policy (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  -- 적용 대상
  department_ids    uuid[],
  job_families      text[],
  -- 시간 조건: 근태 상태 연동
  apply_when        text NOT NULL,   -- ALWAYS | WORKING_HOURS | SCHEDULED_HOURS
  exclude_on_break  boolean NOT NULL DEFAULT true,
  time_windows      jsonb,           -- [{days:[1,2,3,4,5], from:'09:00', to:'18:00'}]

  block_categories  text[],          -- STREAMING | SHOPPING | GAME | SNS | GAMBLING
  blocked_domains   text[],
  allowed_domains   text[],          -- 항상 허용 (진료·업무 사이트)
  action            text NOT NULL,   -- BLOCK | WARN | LOG_ONLY
  priority          int NOT NULL DEFAULT 0,
  is_active         boolean NOT NULL DEFAULT true
);

-- 집계 저장. 개인별 상세 URL은 저장하지 않습니다.
CREATE TABLE pc_usage_summary (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL REFERENCES member(id),
  usage_date        date NOT NULL,
  category          text NOT NULL,
  domain            text,            -- 도메인까지만. 전체 URL·검색어 저장 금지.
  duration_seconds  int NOT NULL DEFAULT 0,
  block_count       int NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, member_id, usage_date, category, domain)
) PARTITION BY RANGE (usage_date);

CREATE TABLE pc_unblock_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  member_id         uuid NOT NULL,
  domain            text NOT NULL,
  reason            text NOT NULL,
  status            text NOT NULL,
  approval_id       uuid,
  scope             text             -- MEMBER | DEPARTMENT | TENANT
);
```

**`pc_usage_summary`에 전체 URL 컬럼이 없는 것은 의도된 설계입니다.** 도메인과 카테고리, 시간만 저장합니다. 상세는 [09. PC 사용 통제](09-pc-usage-control.md), [10. 보안·규제 준수](10-security-compliance.md) 참고.

---

## 10. AI 스케줄링

```sql
CREATE TABLE schedule_generation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  department_id     uuid NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  requested_by      uuid NOT NULL,
  natural_language_input text,       -- 관리자가 입력한 자연어 요청
  parsed_constraints jsonb,          -- LLM이 파싱한 구조화 제약
  solver_config     jsonb,           -- 타임박스, 가중치
  status            text NOT NULL,   -- QUEUED | RUNNING | SUCCEEDED
                                     -- | INFEASIBLE | TIMEOUT | FAILED
  solver_status     text,            -- OPTIMAL | FEASIBLE | INFEASIBLE
  objective_value   numeric,
  unmet_soft_constraints jsonb,      -- 못 지킨 소프트 제약과 이유
  explanation       text,            -- LLM 생성 설명
  duration_ms       int,
  result_roster_id  uuid REFERENCES roster(id)
);

-- 관리자가 AI 결과를 어떻게 고쳤는지 → 제약 학습의 재료
CREATE TABLE schedule_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  generation_id     uuid NOT NULL REFERENCES schedule_generation(id),
  member_id         uuid NOT NULL,
  work_date         date NOT NULL,
  ai_shift_type_id  uuid,
  final_shift_type_id uuid,
  change_reason     text
);

-- 반복 적용되는 개인/부서 제약
CREATE TABLE scheduling_constraint (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  scope_type        text NOT NULL,   -- MEMBER | DEPARTMENT
  scope_id          uuid NOT NULL,
  constraint_type   text NOT NULL,   -- NO_NIGHT | MAX_CONSECUTIVE_NIGHTS
                                     -- | FORBIDDEN_PATTERN | MIN_STAFF
                                     -- | PRECEPTOR_PAIR | FIXED_SHIFT
  params            jsonb NOT NULL,
  is_hard           boolean NOT NULL,
  weight            int,             -- 소프트 제약의 가중치
  effective_from    date,
  effective_to      date,
  note              text
);
```

---

## 11. 감사 로그

```sql
CREATE TABLE audit_log (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  actor_id          uuid,
  actor_type        text NOT NULL,   -- MEMBER | SYSTEM | ADMIN | API
  action            text NOT NULL,   -- CREATE | UPDATE | DELETE | READ_PII | EXPORT | LOGIN
  entity_type       text NOT NULL,
  entity_id         uuid,
  before_data       jsonb,
  after_data        jsonb,
  reason            text,
  ip_address        inet,
  user_agent        text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (occurred_at);
```

- `READ_PII`를 별도 액션으로 두는 이유: 개인정보 조회 이력은 법적으로 관리해야 하는 항목입니다. 주민번호·연락처가 포함된 화면 조회는 전부 남깁니다.
- 이 테이블은 **애플리케이션에서 UPDATE/DELETE 권한을 부여하지 않습니다.** DB 사용자 권한 레벨에서 INSERT만 허용.

---

## 12. 인덱스·파티셔닝 요약

| 테이블 | 파티션 | 핵심 인덱스 |
|---|---|---|
| `attendance_record` | `work_date` 월별 | `(tenant_id, member_id, work_date, captured_at)` |
| `worktime_daily` | `work_date` 월별 | `(tenant_id, member_id, work_date, basis)` |
| `pc_usage_summary` | `usage_date` 월별 | `(tenant_id, member_id, usage_date)` |
| `audit_log` | `occurred_at` 월별 | `(tenant_id, entity_type, entity_id)`, `(tenant_id, actor_id, occurred_at)` |
| `roster_assignment` | — | `(tenant_id, member_id, work_date)`, `(roster_id)` |
| `leave_grant` | — | `(tenant_id, member_id, expires_at)` |

보존 정책:
- `attendance_record`, `worktime_*`: **최소 3년** (근기법상 근로관계 서류 보존 의무). 이후 아카이브.
- `pc_usage_summary`: **6개월 후 자동 삭제.** 개인정보 최소 수집 원칙.
- `audit_log`: 3년 이상, 콜드 스토리지 이관.
- ⚖️ 검토필요: 보존 기간은 개인정보 처리방침과 일치시켜야 합니다.
