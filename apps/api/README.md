# @mediwork/api

MediWork 코어 API. NestJS 모듈러 모놀리스.

## 실행

```bash
pnpm install
pnpm --filter @mediwork/api build
pnpm --filter @mediwork/api start   # :3000
```

`DATABASE_URL`이 없으면 인메모리 저장소로 뜬다. 설정하면 PostgreSQL을 쓴다.
두 구현은 **같은 e2e 스위트**를 통과한다(아래 참고).

## 저장소 · 데이터베이스

| 환경변수 | 용도 | 롤 |
|---|---|---|
| `DATABASE_URL` | 애플리케이션 런타임 | `mediwork_app` — **비-수퍼유저, NOBYPASSRLS** |
| `DATABASE_ADMIN_URL` | 마이그레이션·시드 전용 | 스키마 소유자 |

> ⚠️ **`DATABASE_URL`에 수퍼유저를 넣으면 RLS가 조용히 무력화된다.**
> PostgreSQL에서 수퍼유저와 `BYPASSRLS` 롤은 행 수준 보안을 통째로 건너뛴다.
> `FORCE ROW LEVEL SECURITY`를 켜도 이들에게는 적용되지 않고, 경고도 오류도 없다.
> 개발 중 이 실수로 테넌트 격리 테스트가 전부 통과하는 것처럼 보인 적이 있어서,
> `test/rls.test.ts`에 `rolsuper = false AND rolbypassrls = false`를 확인하는
> 테스트를 못 박아 두었다.

스키마는 `src/db/schema.sql` 한 파일이다. 테넌트 스코프 테이블 전체에
`ENABLE` + `FORCE ROW LEVEL SECURITY`와 `tenant_id = app_current_tenant()`
정책(`USING` + `WITH CHECK`)이 걸린다. 테넌트 값은 요청마다
`SET LOCAL app.tenant_id`로 **트랜잭션 스코프**로만 설정되므로 커넥션 풀에서
재사용돼도 이전 테넌트가 새지 않는다.

감사 로그(`audit_log`)는 애플리케이션 롤에 `UPDATE`/`DELETE` 권한이 없고,
근태 원본(`attendance_record`)은 `DELETE` 권한이 없다. 애플리케이션 버그로도
지워지지 않아야 하는 기록이기 때문이다.

### 로컬 PostgreSQL 준비

```bash
createdb mediwork_test
export DATABASE_ADMIN_URL="postgres://postgres@localhost:5432/mediwork_test"
export DATABASE_URL="postgres://mediwork_app@localhost:5432/mediwork_test"
pnpm --filter @mediwork/api test      # 스키마 생성 + 시드는 reset()이 알아서 한다
```

## 테스트

```bash
pnpm --filter @mediwork/api test
```

- `DATABASE_URL`·`DATABASE_ADMIN_URL`이 **둘 다** 있으면 e2e 스위트가
  인메모리와 PostgreSQL **양쪽에 대해** 돈다(`describe.each`). 저장소를 바꿔도
  동작이 같다는 포트/어댑터의 전제를 매번 확인하기 위해서다.
- 없으면 인메모리만 돌고 RLS 테스트는 스킵된다.
- 테스트 파일은 순차 실행한다(`fileParallelism: false`). 두 파일이 같은 스키마를
  공유하며 각자 `reset()`을 부르기 때문이다.

## 인증 (개발용)

운영에서는 서명 검증된 JWT를 쓴다. 개발 중에는 다음 형식의 헤더를 사용한다.

```
Authorization: dev <tenantId>:<memberId>:<role1,role2>[:<deviceId>]
```

식별자는 UUID다(RLS 정책이 `uuid` 타입 위에 있다). 시드 계정:

| 역할 | 헤더 |
|---|---|
| 3병동 간호사 (김간호) | `dev 11111111-1111-4111-8111-111111111111:11111111-1111-4111-8111-000000000201:MEMBER:device_abc` |
| 3병동 수간호사 (박수간) | `dev 11111111-1111-4111-8111-111111111111:11111111-1111-4111-8111-000000000202:WARD_MANAGER:device_park` |
| 다른 테넌트 (격리 확인용) | `dev 22222222-2222-4222-8222-222222222222:22222222-2222-4222-8222-000000000201:MEMBER:device_bsn` |

테넌트는 **토큰에서만** 결정된다. 클라이언트가 보낸 `tenantId` 파라미터는 무시한다.

## 엔드포인트

| 메서드 | 경로 | 설명 |
|---|---|---|
| `GET` | `/healthz` | 헬스체크 (인증 불필요) |
| `POST` | `/api/v1/attendance/records` | 출퇴근 기록. 위치 검증 + 멱등성 |
| `GET` | `/api/v1/attendance/me/today` | 오늘 내 기록 |
| `GET` | `/api/v1/attendance/me?from=&to=` | 기간별 내 기록 |
| `POST` | `/api/v1/attendance/pending-reviews/:id/resolve` | 승인 대기 처리 (관리자, 사유 필수) |
| `GET` | `/api/v1/rosters/:id` | 근무표 + 규칙 위반 + 주별 집계 |
| `POST` | `/api/v1/rosters/:id/publish` | 근무표 확정 (BLOCK 위반 시 강행 사유 필요) |
| `GET` | `/api/v1/leaves/me/balance?asOf=` | 연차 잔액 + 소멸 예정 |
| `POST` | `/api/v1/leaves/requests` | 휴가 신청 |
| `POST` | `/api/v1/leaves/requests/:id/cancel` | 취소 (잔액 복원) |

## 직접 확인해 보기

```bash
SEOUL=11111111-1111-4111-8111-111111111111
KIM=11111111-1111-4111-8111-000000000201
PARK=11111111-1111-4111-8111-000000000202
WARD3=11111111-1111-4111-8111-000000000301

# 병원 WiFi로 출근 → VERIFIED / HIGH
curl -s localhost:3000/api/v1/attendance/records \
  -H "Authorization: dev $SEOUL:$KIM:MEMBER:device_abc" \
  -H 'Content-Type: application/json' \
  -d '{"recordType":"CHECK_IN","location":{"wifi":[{"bssid":"a4:2b:8c:11:22:33"}]},
       "device":{"deviceId":"device_abc"},"clientNonce":"demo-1"}'

# 근무표의 규칙 위반 확인 (시드에 E→D 퀵리턴을 심어두었다)
curl -s "localhost:3000/api/v1/rosters/$WARD3" \
  -H "Authorization: dev $SEOUL:$PARK:WARD_MANAGER"
```

## 현재 상태

- 저장소는 포트/어댑터다(`src/store/`). `MemoryStore`와 `PgStore`가 같은
  `Store` 인터페이스를 구현하고 같은 e2e 테스트를 통과한다.
  두 구현 모두 `tenantId()` 컨텍스트 없이는 아무것도 읽을 수 없다 —
  테넌트 필터를 "빠뜨릴 수 있는" 코드 경로 자체를 만들지 않았다.
- 멱등성은 2단계다. 애플리케이션이 `clientNonce`를 먼저 조회하고,
  경합으로 뚫리면 DB 유니크 인덱스가 잡아 기존 기록을 돌려준다.
  e2e에 동시 요청 테스트가 있다.
- 결재선, 근태 수정 요청, 급여 Export는 미구현이다. 로드맵 Phase 1 참고.
- DI는 `@Inject(Token)` 명시 방식이다. `emitDecoratorMetadata`에 의존하면
  esbuild 기반 도구(vitest 등)에서 주입이 조용히 실패한다.
