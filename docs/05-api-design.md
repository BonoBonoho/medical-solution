# 05. API 설계

REST + OpenAPI 3.1. `/api/v1` 프리픽스.

---

## 1. 공통 규약

### 1.1 인증

| 클라이언트 | 방식 |
|---|---|
| 웹 | HttpOnly Secure 쿠키 (Access 15분 + Refresh 14일, 회전) |
| 모바일 | Bearer JWT + Refresh Token. 기기 바인딩 필수. |
| 브라우저 확장 | 확장 전용 단기 토큰 (근태 기록 권한 없음, 정책 조회 전용) |
| 외부 연동 | API Key + HMAC 서명 |

**모바일 토큰은 반드시 `device_id`를 클레임에 포함**합니다. 토큰만 탈취해 다른 기기에서 출근 기록하는 것을 막습니다.

```json
{
  "sub": "member-uuid",
  "tid": "tenant-uuid",
  "did": "device-uuid",
  "roles": ["MEMBER"],
  "scope": { "departments": ["dept-uuid"] },
  "exp": 1234567890
}
```

### 1.2 테넌트 컨텍스트

모든 요청은 토큰의 `tid`로 테넌트를 결정합니다. **클라이언트가 보낸 `tenantId` 파라미터는 절대 신뢰하지 않습니다.** 미들웨어에서 `SET LOCAL app.tenant_id`를 설정하고 RLS가 강제합니다.

### 1.3 응답 포맷

```jsonc
// 성공
{ "data": { ... }, "meta": { "requestId": "..." } }

// 목록
{ "data": [ ... ],
  "meta": { "page": 1, "size": 50, "total": 340, "requestId": "..." } }

// 오류
{ "error": {
    "code": "RULE_VIOLATION",
    "message": "확정할 수 없습니다. 위반 3건을 확인하세요.",
    "details": [
      { "ruleCode": "MIN_REST_BETWEEN_SHIFTS",
        "message": "김간호 3/15 N → 3/16 D, 휴식 8시간 (최소 11시간)",
        "legalBasis": "근로기준법 제59조 제2항",
        "subjects": [{ "type": "rosterAssignment", "id": "..." }],
        "suggestion": "3/16을 오프로 변경하면 해소됩니다" }
    ]
  }
}
```

오류 `message`는 **사용자에게 그대로 보여줄 수 있는 한국어**여야 합니다. 별도 번역 레이어를 두지 않습니다.

### 1.4 오류 코드

| HTTP | code | 상황 |
|---|---|---|
| 400 | `VALIDATION_ERROR` | 입력 검증 실패 |
| 401 | `UNAUTHENTICATED` | 토큰 없음/만료 |
| 401 | `DEVICE_NOT_BOUND` | 등록되지 않은 기기 |
| 403 | `FORBIDDEN` | 권한 없음 |
| 403 | `INTEGRITY_FAILED` | 기기 무결성 검증 실패 |
| 404 | `NOT_FOUND` | — |
| 409 | `CONFLICT` | 중복 (이미 체크인 등) |
| 409 | `RULE_VIOLATION` | BLOCK 규칙 위반 |
| 422 | `LOCATION_UNVERIFIED` | 위치 검증 실패 (기록은 됨) |
| 422 | `INSUFFICIENT_BALANCE` | 연차 잔액 부족 |
| 429 | `RATE_LIMITED` | — |
| 503 | `AI_UNAVAILABLE` | AI 서비스 장애 (코어 기능은 정상) |

### 1.5 멱등성

상태를 바꾸는 모든 POST는 `Idempotency-Key` 헤더를 지원합니다. 출퇴근 기록은 **필수**입니다.

---

## 2. 출퇴근 API

### `POST /attendance/records`

```jsonc
// Request
{
  "recordType": "CHECK_IN",           // CHECK_IN | CHECK_OUT | BREAK_START
                                      // | BREAK_END | CALL_START | CALL_END
  "capturedAt": "2026-07-29T06:58:31+09:00",
  "location": {
    "gps": { "lat": 37.5012, "lng": 127.0396,
             "accuracy": 12.4, "isMock": false, "capturedAt": "..." },
    "wifi": [
      { "bssid": "a4:2b:8c:11:22:33", "rssi": -48 },
      { "bssid": "a4:2b:8c:11:22:34", "rssi": -67 }
    ],
    "beacons": []
  },
  "device": {
    "deviceId": "device-uuid",
    "integrityToken": "...",           // Play Integrity / App Attest
    "osVersion": "iOS 18.2",
    "appVersion": "1.4.0"
  },
  "offline": { "queued": false, "sequenceNo": null, "signature": null },
  "clientNonce": "01J8XK..."
}
```

```jsonc
// 200 — 검증 성공
{ "data": {
    "id": "record-uuid",
    "recordType": "CHECK_IN",
    "capturedAt": "2026-07-29T06:58:31+09:00",
    "verification": "VERIFIED",
    "verifyMethod": "WIFI",
    "confidence": "HIGH",
    "worksite": { "id": "...", "name": "본원" },
    "schedule": {                       // 근무표 대조 결과
      "shiftType": { "code": "D", "name": "데이" },
      "scheduledStart": "2026-07-29T07:00:00+09:00",
      "isLate": false, "lateMinutes": 0
    },
    "todaySummary": { "checkedInAt": "...", "expectedEndAt": "..." }
} }
```

```jsonc
// 422 — 위치 검증 실패. 기록은 저장됨.
{ "error": {
    "code": "LOCATION_UNVERIFIED",
    "message": "위치를 확인할 수 없어 승인 대기로 기록했습니다. 관리자 확인 후 반영됩니다.",
    "details": [{ "reason": "GEOFENCE_OUT", "distanceM": 340 }]
  },
  "data": { "id": "record-uuid", "verification": "PENDING_REVIEW" }
}
```

**422에도 `data`를 함께 반환하는 것이 의도된 설계입니다.** 앱은 "기록되었으나 승인 대기"를 정확히 표시할 수 있어야 합니다. 실패로만 처리하면 직원은 재시도를 반복하고, 결국 출근 기록이 없는 상태가 됩니다.

### `POST /attendance/records/batch` — 오프라인 큐 동기화

```jsonc
{ "records": [ /* 위와 동일한 객체 배열, sequenceNo 오름차순 */ ] }
```

응답은 건별 결과 배열. 일부 실패해도 나머지는 처리합니다.

### `GET /attendance/me/today`
### `GET /attendance/me?from=&to=`
### `GET /attendance/members/{memberId}?from=&to=` — 관리자

### `POST /attendance/corrections`

```jsonc
{ "workDate": "2026-07-28",
  "originalRecordId": null,             // null = 누락 보완
  "recordType": "CHECK_OUT",
  "correctedAt": "2026-07-28T23:40:00+09:00",
  "reasonCode": "FORGOT",
  "reasonText": "인계 중 기록을 잊었습니다" }
```

### `POST /attendance/pending-reviews/{id}/resolve` — 관리자

```jsonc
{ "action": "APPROVE", "comment": "본관 지하 통신 불량 확인" }
```

---

## 3. 근무표 API

### `GET /rosters?departmentId=&periodStart=`

### `GET /rosters/{id}`

```jsonc
{ "data": {
    "id": "...", "status": "DRAFT", "version": 2,
    "period": { "start": "2026-08-01", "end": "2026-08-31" },
    "department": { "id": "...", "name": "3병동" },
    "shiftTypes": [ { "id":"...", "code":"D", "name":"데이",
                      "startTime":"07:00", "endTime":"15:00", "color":"#4A90D9" } ],
    "members": [ { "id":"...", "name":"김간호", "position":"간호사",
                   "employmentType":"REGULAR" } ],
    "assignments": [ { "memberId":"...", "workDate":"2026-08-01",
                       "shiftTypeId":"...", "source":"AI" } ],
    "violations": [ /* 실시간 규칙 검증 결과 */ ],
    "coverage": [ { "date":"2026-08-01", "shiftTypeId":"...",
                    "assigned":4, "required":5, "status":"UNDERSTAFFED" } ]
} }
```

`coverage`를 함께 내려주는 이유: 근무표 편집기에서 인력 부족을 실시간으로 보여줘야 하는데, 클라이언트에서 매번 재계산하면 6,200셀 그리드에서 느려집니다.

### `PATCH /rosters/{id}/assignments` — 벌크 편집

```jsonc
{ "changes": [
    { "op": "SET",    "memberId":"...", "workDate":"2026-08-03", "shiftTypeId":"..." },
    { "op": "DELETE", "memberId":"...", "workDate":"2026-08-05" }
  ],
  "revalidate": true }
```

편집기는 셀 단위로 API를 때리지 않고 **디바운스하여 벌크 전송**합니다. 응답에 갱신된 `violations`와 `coverage`가 포함됩니다.

### `POST /rosters/{id}/publish`

```jsonc
{ "notifyMembers": true, "overrideViolations": [
    { "violationId": "...", "reason": "인력 부족으로 불가피, 원장 승인" } ] }
```

BLOCK 위반이 있으면 `overrideViolations` 없이는 409를 반환합니다. 사유를 넣으면 진행되고 기록이 남습니다.

### `POST /roster-generations` — AI 생성 요청

```jsonc
{ "departmentId": "...",
  "period": { "start": "2026-09-01", "end": "2026-09-30" },
  "naturalLanguageInput": "김수진 간호사 9월엔 나이트 빼주세요. 셋째 주 금요일은 병동 회식이라 이브닝 최소 인원으로. 신규 2명은 프리셉터랑 같은 듀티로 묶어주세요.",
  "options": { "timeboxSeconds": 60, "baseRosterId": null,
               "preserveExisting": false } }
```

```jsonc
// 202 Accepted
{ "data": { "generationId": "...", "status": "QUEUED",
            "estimatedSeconds": 45,
            "streamUrl": "/roster-generations/{id}/stream" } }
```

### `GET /roster-generations/{id}/stream` — SSE

```
event: parsed
data: {"constraints":[{"type":"NO_NIGHT","member":"김수진","confidence":0.97}, ...]}

event: solving
data: {"elapsedMs":12000,"bestObjective":184,"feasible":true}

event: completed
data: {"status":"SUCCEEDED","rosterId":"...","unmetSoftConstraints":[...],
       "explanation":"요청하신 조건 중 ..."}
```

**SSE로 진행 상황을 스트리밍하는 이유**: 60초를 그냥 기다리게 하면 사용자는 멈춘 줄 압니다. 제약 파싱 결과를 먼저 보여주면 "AI가 내 말을 제대로 알아들었는지"를 즉시 확인할 수 있고, 잘못 파싱됐으면 바로 취소할 수 있습니다.

### `POST /roster-generations/{id}/apply`

```jsonc
{ "targetRosterId": "...", "mode": "REPLACE" }   // REPLACE | MERGE
```

### `POST /shift-swaps` / `POST /shift-swaps/{id}/respond` / `POST /shift-swaps/{id}/approve`

---

## 4. 휴가 API

### `GET /leaves/me/balance`

```jsonc
{ "data": {
    "asOf": "2026-07-29",
    "annual": {
      "granted": 17.0, "used": 6.5, "scheduled": 2.0, "remaining": 8.5,
      "expiringSoon": [ { "days": 3.0, "expiresAt": "2026-12-31" } ],
      "grants": [
        { "id":"...", "reason":"BASE_15", "grantedDays":15,
          "usedDays":6.5, "effectiveFrom":"2026-01-01", "expiresAt":"2026-12-31" },
        { "id":"...", "reason":"TENURE_EXTRA", "grantedDays":2,
          "usedDays":0, "effectiveFrom":"2026-01-01", "expiresAt":"2026-12-31" }
      ]
    },
    "compLeave": { "granted": 1.5, "used": 0, "remaining": 1.5 }
} }
```

잔액을 단일 숫자가 아니라 `grants` 배열까지 함께 주는 이유: 직원이 "내 연차가 왜 이만큼이지?"를 스스로 확인할 수 있어야 문의가 줄어듭니다.

### `POST /leaves/requests`

```jsonc
{ "leaveTypeId": "...",
  "startAt": "2026-08-12T00:00:00+09:00",
  "endAt": "2026-08-13T23:59:59+09:00",
  "reason": "가족 여행",
  "evidenceFileKey": null }
```

```jsonc
// 200 — 제출 전 시뮬레이션 결과 포함
{ "data": {
    "id": "...", "status": "PENDING", "daysCount": 2.0,
    "deductions": [ { "grantId":"...", "days":2.0, "expiresAt":"2026-12-31" } ],
    "balanceAfter": { "remaining": 6.5 },
    "approvalSteps": [ { "order":1, "approver":{"name":"박수간","id":"..."} } ],
    "warnings": [
      { "code":"TEAM_COVERAGE",
        "message":"8/12 3병동 데이 근무 인원이 최소 기준(5명)보다 1명 부족해집니다" }
    ]
} }
```

`warnings`가 중요합니다. 승인자가 근무표를 따로 열어보지 않아도 영향을 알 수 있어야 합니다.

### `GET /leaves/requests?status=&departmentId=`
### `POST /leaves/requests/{id}/cancel`
### `POST /approvals/{id}/actions` — 승인/반려 (범용)

```jsonc
{ "action": "APPROVE", "comment": "" }
```

### `GET /leaves/calendar?departmentId=&from=&to=` — 팀 휴가 캘린더

### `POST /leaves/promotions` — 연차 사용촉진 실행 (관리자)

---

## 5. 컴플라이언스 API

### `GET /compliance/worktime/summary?memberId=&from=&to=&basis=ACTUAL`

```jsonc
{ "data": {
    "period": { "from":"2026-07-01", "to":"2026-07-31" },
    "basis": "ACTUAL",
    "totals": { "workMinutes": 10080, "overtimeMinutes": 1320,
                "nightMinutes": 2400, "holidayMinutes": 480 },
    "weekly": [
      { "weekStart":"2026-07-06", "totalMinutes":3180,
        "limitMinutes":3120, "status":"EXCEEDED" }
    ],
    "ruleSetVersion": "kr-health-2026.1"
} }
```

### `GET /compliance/alerts?severity=&status=`

### `GET /compliance/residents/{memberId}/training` — 전공의 수련시간

```jsonc
{ "data": {
    "currentWeek":   { "minutes": 4380, "limitMinutes": null, "status": "..." },
    "fourWeekAvg":   { "minutes": 4200, "limitMinutes": null, "status": "..." },
    "maxContinuous": { "minutes": 1980, "limitMinutes": null, "status": "..." },
    "dutyCountThisWeek": 2,
    "offDaysThisMonth": 3,
    "ruleSetVersion": "kr-resident-2026.1"
} }
```

> `limitMinutes`가 `null`인 것은 [02. 도메인 규칙 §3.2](02-domain-rules.md#32-️-파라미터-값에-대한-중요-경고)에 따라 **현행 조문 확인 후 확정**할 값이기 때문입니다. 임의의 수치를 넣어두면 그대로 출시될 위험이 있어 의도적으로 비워둡니다.

### `GET /compliance/reports/nursing-grade?quarter=2026Q3` ⚖️

```jsonc
{ "data": {
    "quarter": "2026Q3",
    "regulationVersion": "고시 제____-___호",   // 사용된 고시 버전 명시
    "averageOperatingBeds": 210,
    "nurseCount": { "total": 47.3, "included": 45.1, "excluded": 2.2 },
    "excludedMembers": [
      { "memberId":"...", "name":"...", "reason":"휴직", "days": 62 }
    ],
    "computedRatio": 4.66,
    "estimatedGrade": null,                      // 고시 확인 후 산정
    "dataQualityWarnings": [
      { "code":"MISSING_RECORDS",
        "message":"3명의 근무 기록이 일부 누락되어 있습니다", "memberIds":[...] }
    ],
    "disclaimer": "본 산출값은 참고용입니다. 최종 신고 전 반드시 현행 고시 기준으로 검토하십시오."
} }
```

`dataQualityWarnings`와 `disclaimer`는 필수 필드입니다. 수가 신고는 오류 시 환수로 이어지므로, 제품이 확신을 주면 안 되고 **검토를 유도**해야 합니다.

### `POST /compliance/exports/labor-inspection` — 근로감독 대응 자료

---

## 6. PC 사용 통제 API

### `GET /pc-control/policy` — 확장이 주기적으로 폴링

```jsonc
{ "data": {
    "policyVersion": "v-2026072901",
    "memberState": "WORKING",           // WORKING | BREAK | OFF_DUTY
    "action": "BLOCK",
    "blockCategories": ["STREAMING","GAME","GAMBLING"],
    "blockedDomains": ["netflix.com","*.netflix.com","youtube.com"],
    "allowedDomains": ["*.hira.or.kr","*.kmle.co.kr","uptodate.com"],
    "nextCheckSeconds": 300,
    "notice": "근무시간 중 업무 외 사이트 접속이 제한됩니다. 휴게시간에는 해제됩니다."
} }
```

- `memberState`를 서버가 계산해 내려줍니다. 확장이 근태 상태를 스스로 판단하면 정책 우회 여지가 생깁니다.
- `notice`를 정책에 포함하는 이유: 차단 화면에서 **왜 차단되는지**를 항상 표시하기 위함입니다. 투명성은 이 기능의 법적 정당성과 직결됩니다.

### `POST /pc-control/usage` — 사용 집계 보고

```jsonc
{ "policyVersion": "v-2026072901",
  "entries": [
    { "category":"STREAMING", "domain":"netflix.com",
      "durationSeconds": 0, "blockCount": 3, "date":"2026-07-29" },
    { "category":"WORK", "domain":"hira.or.kr",
      "durationSeconds": 1840, "blockCount": 0, "date":"2026-07-29" }
  ] }
```

**전체 URL, 페이지 제목, 검색어를 보내지 않습니다.** 확장에서 도메인으로 잘라 카테고리와 함께 집계한 뒤 보고합니다.

### `GET /pc-control/reports?departmentId=&from=&to=`
### `POST /pc-control/unblock-requests`

---

## 7. AI 서비스 내부 API

Core API만 호출합니다. 외부 노출하지 않습니다. (VPC 내부, mTLS)

### `POST /internal/ai/schedule/generate`

```jsonc
{ "context": {
    "period": { "start":"2026-09-01", "end":"2026-09-30" },
    "members": [ { "id":"m1", "name":"김간호", "employmentType":"REGULAR",
                   "isNewbie": false, "credentials":["ICU"] } ],
    "shiftTypes": [ { "id":"D", "isNight":false, "startTime":"07:00",
                      "endTime":"15:00" } ],
    "demand": [ { "date":"2026-09-01", "shiftTypeId":"D", "min":5, "ideal":6 } ],
    "fixedAssignments": [ { "memberId":"m3", "date":"2026-09-05",
                            "shiftTypeId":"A", "reason":"승인된 연차" } ],
    "offRequests": [ { "memberId":"m1", "date":"2026-09-12",
                       "preference":"MUST_OFF" } ],
    "priorPeriodTail": [ { "memberId":"m1", "date":"2026-08-31",
                           "shiftTypeId":"N" } ],
    "constraints": [ { "type":"FORBIDDEN_PATTERN",
                       "params":{"pattern":["E","D"]}, "isHard":true } ],
    "ruleSet": { /* 법정 제약 */ }
  },
  "naturalLanguageInput": "...",
  "options": { "timeboxSeconds": 60 } }
```

`priorPeriodTail`이 빠지면 매월 1일에 규칙 위반이 발생합니다. 8월 31일 나이트 근무자가 9월 1일 데이에 배정되는 사고가 실제로 자주 일어납니다.

### `POST /internal/ai/anomaly/detect`
### `POST /internal/ai/assistant/query`

---

## 8. 웹훅 (외부 연동)

| 이벤트 | 페이로드 |
|---|---|
| `roster.published` | 근무표 확정 |
| `leave.approved` | 휴가 승인 |
| `compliance.violation` | 법정한도 위반 감지 |
| `worktime.closed` | 월 근태 마감 (급여 시스템 트리거) |

HMAC-SHA256 서명(`X-MediWork-Signature`), 최대 5회 지수 백오프 재시도.

---

## 9. 레이트 리밋

| 엔드포인트 | 제한 |
|---|---|
| `POST /attendance/records` | 회원당 20/분 |
| `POST /roster-generations` | 테넌트당 10/시간 (비용이 큰 연산) |
| `GET /pc-control/policy` | 기기당 30/시간 |
| 일반 조회 | 회원당 300/분 |

교대 시각(07:00, 15:00, 23:00 전후)에 출퇴근 요청이 집중됩니다. **레이트 리밋이 교대 러시를 막지 않도록** 넉넉히 잡고, 대신 인프라를 스케줄 기반으로 사전 스케일아웃합니다.
