# @mediwork/api

MediWork 코어 API. NestJS 모듈러 모놀리스.

## 실행

```bash
pnpm install
pnpm --filter @mediwork/api build
pnpm --filter @mediwork/api start   # :3000
```

## 인증 (개발용)

운영에서는 서명 검증된 JWT를 쓴다. 개발 중에는 다음 형식의 헤더를 사용한다.

```
Authorization: dev <tenantId>:<memberId>:<role1,role2>[:<deviceId>]
```

시드 계정:

| 헤더 | 설명 |
|---|---|
| `dev tenant_seoul:mem_kim:MEMBER:device_abc` | 3병동 간호사 |
| `dev tenant_seoul:mem_park:WARD_MANAGER:device_park` | 3병동 수간호사 |
| `dev tenant_busan:mem_busan:MEMBER:device_bsn` | 다른 테넌트 (격리 확인용) |

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
# 병원 WiFi로 출근 → VERIFIED / HIGH
curl -s localhost:3000/api/v1/attendance/records \
  -H 'Authorization: dev tenant_seoul:mem_kim:MEMBER:device_abc' \
  -H 'Content-Type: application/json' \
  -d '{"recordType":"CHECK_IN","location":{"wifi":[{"bssid":"a4:2b:8c:11:22:33"}]},
       "device":{"deviceId":"device_abc"},"clientNonce":"demo-1"}'

# 근무표의 규칙 위반 확인 (시드에 E→D 퀵리턴을 심어두었다)
curl -s localhost:3000/api/v1/rosters/roster_ward3_202608 \
  -H 'Authorization: dev tenant_seoul:mem_park:WARD_MANAGER'
```

## 현재 상태

- 저장소는 인메모리다(`src/store/memory-store.ts`). 운영에서는 PostgreSQL + RLS로 교체한다.
  다만 지금도 `scoped()`를 거치지 않으면 데이터를 읽을 수 없게 해, 테넌트 필터를
  빠뜨릴 수 없는 구조는 DB로 옮겨가도 그대로 유지된다.
- 결재선, 근태 수정 요청, 급여 Export는 미구현이다. 로드맵 Phase 1 참고.
- DI는 `@Inject(Token)` 명시 방식이다. `emitDecoratorMetadata`에 의존하면
  esbuild 기반 도구(vitest 등)에서 주입이 조용히 실패한다.
