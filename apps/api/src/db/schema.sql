-- MediWork 스키마 (PostgreSQL 16)
--
-- 설계 근거는 docs/04-data-model.md 참고.
-- 핵심 원칙 두 가지가 이 파일에 강제되어 있다.
--   1. 테넌트 격리는 애플리케이션이 아니라 DB(RLS)가 보장한다.
--      코드가 WHERE 절을 빠뜨려도 다른 병원의 데이터가 새지 않아야 한다.
--   2. 근태 원본은 UPDATE하지 않는다. 분쟁 시 증거가 되기 때문이다.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "ltree";

-- ---------------------------------------------------------------------------
-- 조직
-- ---------------------------------------------------------------------------

CREATE TABLE tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  plan          text NOT NULL DEFAULT 'BASIC',
  status        text NOT NULL DEFAULT 'ACTIVE',
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worksite (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  address               text,
  -- 5인 미만 사업장에는 가산수당 규정이 적용되지 않는다. 규칙 분기의 입력.
  employee_count_tier   text NOT NULL DEFAULT 'FROM_5'
    CHECK (employee_count_tier IN ('UNDER_5', 'FROM_5', 'FROM_50', 'FROM_300')),
  timezone              text NOT NULL DEFAULT 'Asia/Seoul',
  licensed_beds         int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

-- 근로시간 특례 등 서면합의. 만료되면 관련 규칙이 자동으로 꺼져야 한다.
CREATE TABLE labor_agreement (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  worksite_id       uuid NOT NULL REFERENCES worksite(id) ON DELETE CASCADE,
  agreement_type    text NOT NULL
    CHECK (agreement_type IN ('SPECIAL_EXCEPTION_59', 'COMP_LEAVE_57', 'FLEXIBLE_51', 'SELECTIVE_52')),
  title             text NOT NULL,
  effective_from    date NOT NULL,
  effective_to      date NOT NULL,
  rep_name          text,
  file_key          text,
  params            jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON labor_agreement (tenant_id, worksite_id, agreement_type, effective_to);

CREATE TABLE department (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  worksite_id   uuid NOT NULL REFERENCES worksite(id) ON DELETE CASCADE,
  parent_id     uuid REFERENCES department(id),
  name          text NOT NULL,
  dept_type     text NOT NULL
    CHECK (dept_type IN ('CLINICAL_DEPT', 'WARD', 'ADMIN', 'FACILITY')),
  -- 권한 스코프가 "이 부서와 하위 전체"로 정의되므로 재귀 CTE보다 ltree가 빠르고 단순하다.
  path          ltree NOT NULL,
  ward_beds     int,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON department USING gist (path);

CREATE TABLE member (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  employee_no       text NOT NULL,
  name              text NOT NULL,
  -- 고유식별정보는 별도 KMS 키로 암호화한 바이트열만 저장한다. 평문 컬럼은 없다.
  rrn_encrypted     bytea,
  rrn_hash          text,
  phone_encrypted   bytea,
  email             text,
  hire_date         date NOT NULL,
  resign_date       date,
  worksite_id       uuid NOT NULL REFERENCES worksite(id),
  department_id     uuid NOT NULL REFERENCES department(id),
  job_family        text NOT NULL
    CHECK (job_family IN ('DOCTOR','RESIDENT','NURSE','NURSE_AIDE','MED_TECH','PHARMACIST','ADMIN','FACILITY')),
  employment_type   text NOT NULL
    CHECK (employment_type IN ('REGULAR','CONTRACT','PART_TIME','TEMPORARY','CONTRACT_PROF')),
  status            text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','ON_LEAVE','RESIGNED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, employee_no)
);
CREATE INDEX ON member (tenant_id, department_id);

-- ---------------------------------------------------------------------------
-- 위치 검증
-- ---------------------------------------------------------------------------

CREATE TABLE geofence (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  worksite_id   uuid NOT NULL REFERENCES worksite(id) ON DELETE CASCADE,
  name          text NOT NULL,
  center_lat    double precision NOT NULL,
  center_lng    double precision NOT NULL,
  radius_m      int NOT NULL CHECK (radius_m BETWEEN 20 AND 2000),
  is_active     boolean NOT NULL DEFAULT true
);

-- BSSID로 검증한다. SSID는 이름일 뿐이라 같은 이름의 핫스팟을 누구나 만들 수 있다.
CREATE TABLE worksite_wifi_ap (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  worksite_id   uuid NOT NULL REFERENCES worksite(id) ON DELETE CASCADE,
  bssid         macaddr NOT NULL,
  ssid          text,
  label         text,
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, bssid)
);

-- ---------------------------------------------------------------------------
-- 근무유형 · 근무표
-- ---------------------------------------------------------------------------

CREATE TABLE shift_type (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  worksite_id           uuid REFERENCES worksite(id),
  code                  text NOT NULL,
  name                  text NOT NULL,
  color                 text,
  category              text NOT NULL
    CHECK (category IN ('WORK','OFF','LEAVE','DUTY','ONCALL')),
  start_time            time,
  end_time              time,
  break_minutes         int NOT NULL DEFAULT 0,
  -- 계산식으로 표현할 수 없는 유급시간(노사합의로 정한 당직 등)을 값으로 못박는다.
  paid_minutes_override int,
  counts_as_work        boolean NOT NULL DEFAULT true,
  duty_mode             text CHECK (duty_mode IN ('FULL_WORK','CALL_ONLY','POLICY_RATIO')),
  duty_ratio            numeric(4,3),
  is_night              boolean NOT NULL DEFAULT false,
  sort_order            int NOT NULL DEFAULT 0,
  is_active             boolean NOT NULL DEFAULT true,
  CHECK (duty_mode <> 'POLICY_RATIO' OR duty_ratio IS NOT NULL),
  UNIQUE (tenant_id, worksite_id, code)
);

CREATE TABLE roster (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  department_id     uuid NOT NULL REFERENCES department(id),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  status            text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','REVIEW','PUBLISHED','CLOSED')),
  version           int NOT NULL DEFAULT 1,
  published_at      timestamptz,
  published_by      uuid REFERENCES member(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, department_id, period_start, version)
);

CREATE TABLE roster_assignment (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  roster_id         uuid NOT NULL REFERENCES roster(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id),
  work_date         date NOT NULL,
  shift_type_id     uuid NOT NULL REFERENCES shift_type(id),
  start_override    time,
  end_override      time,
  note              text,
  source            text NOT NULL DEFAULT 'MANUAL'
    CHECK (source IN ('MANUAL','AI','PATTERN','SWAP')),
  UNIQUE (tenant_id, roster_id, member_id, work_date)
);
CREATE INDEX ON roster_assignment (tenant_id, member_id, work_date);

CREATE TABLE holiday (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  holiday_date  date NOT NULL,
  name          text NOT NULL,
  UNIQUE (tenant_id, holiday_date)
);

-- ---------------------------------------------------------------------------
-- 근태
-- ---------------------------------------------------------------------------

CREATE TABLE member_device (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id           uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  platform            text NOT NULL CHECK (platform IN ('IOS','ANDROID')),
  device_name         text,
  device_fingerprint  text NOT NULL,
  public_key          text,
  status              text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('ACTIVE','REVOKED','PENDING')),
  registered_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  UNIQUE (tenant_id, member_id, device_fingerprint)
);

CREATE TABLE attendance_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id),
  work_date         date NOT NULL,
  record_type       text NOT NULL
    CHECK (record_type IN ('CHECK_IN','CHECK_OUT','BREAK_START','BREAK_END','CALL_START','CALL_END')),
  captured_at       timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  verification      text NOT NULL
    CHECK (verification IN ('VERIFIED','PENDING_REVIEW','REJECTED')),
  verify_method     text,
  confidence        text,
  worksite_id       uuid REFERENCES worksite(id),
  reason            text,
  -- 위치 원본은 90일 후 이 jsonb에서 제거하고 검증 결과만 남긴다.
  evidence          jsonb NOT NULL DEFAULT '{}',
  source            text NOT NULL DEFAULT 'MOBILE'
    CHECK (source IN ('MOBILE','WEB','KIOSK','ADMIN','IMPORT')),
  device_id         uuid REFERENCES member_device(id),
  client_nonce      text,
  offline_queued    boolean NOT NULL DEFAULT false,
  sequence_no       bigint,
  is_superseded     boolean NOT NULL DEFAULT false
);
-- 멱등성. 지하철에서 재시도로 중복 체크인되는 사고를 DB가 막는다.
CREATE UNIQUE INDEX attendance_record_nonce_uq
  ON attendance_record (tenant_id, member_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
CREATE INDEX ON attendance_record (tenant_id, member_id, work_date, captured_at);

-- ---------------------------------------------------------------------------
-- 휴가
-- ---------------------------------------------------------------------------

CREATE TABLE leave_type (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code                  text NOT NULL,
  name                  text NOT NULL,
  is_paid               boolean NOT NULL DEFAULT true,
  deducts_from_balance  boolean NOT NULL DEFAULT false,
  balance_source        text CHECK (balance_source IN ('ANNUAL','COMP_LEAVE')),
  requires_evidence     boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  CHECK (deducts_from_balance = false OR balance_source IS NOT NULL),
  UNIQUE (tenant_id, code)
);

-- 잔액을 단일 숫자로 두지 않고 부여 건별 원장으로 관리한다.
-- 연차는 발생일마다 소멸일이 다르고, 사용촉진·미사용수당 정산 시
-- "어느 연차가 언제 소멸했는지"를 증빙해야 한다.
CREATE TABLE leave_grant (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
  balance_source    text NOT NULL CHECK (balance_source IN ('ANNUAL','COMP_LEAVE')),
  grant_reason      text NOT NULL,
  -- 정수 단위(1일 = 100). float를 쓰면 반차·반반차 누적에서 반드시 오차가 생긴다.
  granted_units     int NOT NULL CHECK (granted_units >= 0),
  used_units        int NOT NULL DEFAULT 0 CHECK (used_units >= 0),
  expired_units     int NOT NULL DEFAULT 0 CHECK (expired_units >= 0),
  effective_from    date NOT NULL,
  expires_at        date NOT NULL,
  -- 산정 근거. "왜 이만큼 받았나"에 답할 수 있어야 한다.
  grant_basis       jsonb NOT NULL DEFAULT '{}',
  note              text,
  CHECK (used_units + expired_units <= granted_units)
);
CREATE INDEX ON leave_grant (tenant_id, member_id, expires_at);

CREATE TABLE leave_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id         uuid NOT NULL REFERENCES member(id),
  leave_type_id     uuid NOT NULL REFERENCES leave_type(id),
  start_date        date NOT NULL,
  end_date          date NOT NULL,
  units             int NOT NULL CHECK (units > 0),
  reason            text,
  evidence_file_key text,
  status            text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','CANCELLED','CANCEL_PENDING')),
  applied_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);
CREATE INDEX ON leave_request (tenant_id, member_id, start_date);

CREATE TABLE leave_deduction (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  leave_request_id  uuid NOT NULL REFERENCES leave_request(id) ON DELETE CASCADE,
  leave_grant_id    uuid NOT NULL REFERENCES leave_grant(id),
  units             int NOT NULL CHECK (units > 0)
);
CREATE INDEX ON leave_deduction (tenant_id, leave_request_id);

-- ---------------------------------------------------------------------------
-- 규칙 위반 · 감사
-- ---------------------------------------------------------------------------

CREATE TABLE rule_violation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id         uuid REFERENCES member(id),
  rule_code         text NOT NULL,
  severity          text NOT NULL CHECK (severity IN ('BLOCK','WARN','INFO')),
  basis             text NOT NULL CHECK (basis IN ('PLANNED','ACTUAL')),
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  detail            jsonb NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','ACKNOWLEDGED','JUSTIFIED','RESOLVED')),
  -- 위반을 막는 게 아니라 기록하는 것이 목적이다. 강행 사유가 곧 자산이 된다.
  override_reason   text,
  override_by       uuid REFERENCES member(id),
  override_at       timestamptz,
  detected_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  actor_id          uuid,
  actor_type        text NOT NULL DEFAULT 'MEMBER',
  action            text NOT NULL,
  entity_type       text NOT NULL,
  entity_id         text,
  before_data       jsonb,
  after_data        jsonb,
  reason            text,
  ip_address        inet,
  user_agent        text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, entity_type, entity_id);
CREATE INDEX ON audit_log (tenant_id, actor_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- 애플리케이션 필터링만 믿지 않는다. 실수 한 번이 다른 병원의 인사 데이터
-- 노출로 이어지는 도메인이므로 DB가 최종 방어선이 된다.
-- 요청마다 `SET LOCAL app.tenant_id = '<uuid>'` 를 설정한다.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE
  t text;
  tenant_scoped text[] := ARRAY[
    'worksite','labor_agreement','department','member',
    'geofence','worksite_wifi_ap',
    'shift_type','roster','roster_assignment','holiday',
    'member_device','attendance_record',
    'leave_type','leave_grant','leave_request','leave_deduction',
    'rule_violation','audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE: 테이블 소유자에게도 정책을 적용한다. 이게 없으면 마이그레이션
    -- 사용자로 접속했을 때 정책이 조용히 우회된다.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    $f$, t);
  END LOOP;
END $$;

-- tenant 테이블은 슬러그로 테넌트를 찾아야 하므로 별도 정책을 쓴다.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ---------------------------------------------------------------------------
-- 애플리케이션 롤
--
-- ⚠️ 애플리케이션은 반드시 이 롤로 접속해야 한다.
--
-- PostgreSQL 수퍼유저와 BYPASSRLS 롤은 RLS를 **통째로 우회**한다.
-- FORCE ROW LEVEL SECURITY 도 이들에게는 적용되지 않는다. 즉 앱이
-- 수퍼유저(예: postgres)로 붙으면 위에 만든 정책이 전부 무의미해지고,
-- 그 사실이 아무 오류 없이 조용히 지나간다.
-- 마이그레이션·시드만 소유자 권한으로 실행하고, 요청 처리는 이 롤로 한다.
--
-- 감사 로그는 INSERT만 허용한다. 관리자도 삭제할 수 없어야 한다.
-- 근태 원본은 DELETE를 막는다.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediwork_app') THEN
    CREATE ROLE mediwork_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE mediwork_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mediwork_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mediwork_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mediwork_app;

REVOKE UPDATE, DELETE ON audit_log FROM mediwork_app;
REVOKE DELETE ON attendance_record FROM mediwork_app;
