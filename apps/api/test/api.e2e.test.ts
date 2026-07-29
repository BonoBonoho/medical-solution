/**
 * API e2e.
 *
 * **같은 스위트를 인메모리와 PostgreSQL 양쪽에 대해 돌린다.**
 * 저장소 구현을 바꿔도 동작이 같아야 한다는 것이 포트/어댑터 구조의 전제이고,
 * 그 전제를 매번 확인하지 않으면 구현이 조용히 갈라진다.
 *
 * DATABASE_URL이 없으면 인메모리만 돌린다.
 */

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { runWithContext } from '../src/common/tenant-context.js';
import { Db } from '../src/db/pool.js';
import { MemoryStore } from '../src/store/memory.store.js';
import { PgStore } from '../src/store/pg.store.js';
import { STORE, type Store } from '../src/store/ports.js';
import {
  LEAVE_TYPE_IDS,
  MEM_BUSAN,
  MEM_KIM,
  MEM_PARK,
  ROSTER_WARD3,
  TENANT_BUSAN,
  TENANT_SEOUL,
} from '../src/store/seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const DATABASE_ADMIN_URL = process.env['DATABASE_ADMIN_URL'];

const SEOUL_NURSE = `dev ${TENANT_SEOUL}:${MEM_KIM}:MEMBER:device_abc`;
const SEOUL_MANAGER = `dev ${TENANT_SEOUL}:${MEM_PARK}:WARD_MANAGER:device_park`;
const BUSAN_NURSE = `dev ${TENANT_BUSAN}:${MEM_BUSAN}:MEMBER:device_bsn`;

const HOSPITAL = { lat: 37.5268, lng: 127.1085 };

interface Backend {
  readonly name: string;
  readonly create: () => Promise<Store>;
}

const backends: Backend[] = [
  { name: 'memory', create: async () => new MemoryStore() },
];
if (DATABASE_URL !== undefined && DATABASE_ADMIN_URL !== undefined) {
  backends.push({
    name: 'postgres',
    create: async () => {
      const store = new PgStore(
        new Db({ connectionString: DATABASE_URL }),
        new Db({ connectionString: DATABASE_ADMIN_URL }),
      );
      await store.reset();
      return store;
    },
  });
}

describe.each(backends)('[$name] MediWork API', (backend) => {
  let app: INestApplication;
  let store: Store;

  beforeAll(async () => {
    store = await backend.create();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(STORE)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await store.close();
  });

  const api = () => request(app.getHttpServer());

  // -------------------------------------------------------------------------

  describe('인증 · 테넌트 격리', () => {
    it('헬스체크는 인증 없이 접근할 수 있다', async () => {
      await api().get('/healthz').expect(200, { status: 'ok' });
    });

    it('토큰이 없으면 401이다', async () => {
      const res = await api().get('/api/v1/attendance/me/today').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('다른 테넌트의 근무표는 조회되지 않는다', async () => {
      await api()
        .get(`/api/v1/rosters/${ROSTER_WARD3}`)
        .set('Authorization', SEOUL_NURSE)
        .expect(200);

      const res = await api()
        .get(`/api/v1/rosters/${ROSTER_WARD3}`)
        .set('Authorization', BUSAN_NURSE)
        .expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('다른 테넌트의 근태 기록은 보이지 않는다', async () => {
      await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', BUSAN_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { wifi: [{ bssid: 'b8:27:eb:aa:bb:cc' }] },
          device: { deviceId: 'device_bsn' },
          clientNonce: 'busan-1',
        })
        .expect(200);

      const seoul = await api()
        .get('/api/v1/attendance/me/today')
        .set('Authorization', SEOUL_NURSE)
        .expect(200);
      expect(
        seoul.body.data.every((r: { memberId: string }) => r.memberId !== MEM_BUSAN),
      ).toBe(true);
    });
  });

  describe('출퇴근 기록', () => {
    it('병원 WiFi가 확인되면 HIGH 신뢰도로 승인된다', async () => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { wifi: [{ bssid: 'A4:2B:8C:11:22:33' }] },
          device: { deviceId: 'device_abc', integrityVerified: true },
          clientNonce: 'checkin-wifi-1',
        })
        .expect(200);

      expect(res.body.data.verification).toBe('VERIFIED');
      expect(res.body.data.verifyMethod).toBe('WIFI');
      expect(res.body.data.confidence).toBe('HIGH');
      expect(res.body.data.worksiteId).not.toBeNull();
    });

    it('멱등성 — 같은 clientNonce로 재시도해도 중복 생성되지 않는다', async () => {
      const send = () =>
        api()
          .post('/api/v1/attendance/records')
          .set('Authorization', SEOUL_NURSE)
          .send({
            recordType: 'CHECK_IN',
            location: { gps: { ...HOSPITAL, accuracy: 12 } },
            device: { deviceId: 'device_abc' },
            clientNonce: 'idempotent-key-1',
          })
          .expect(200);

      const first = await send();
      const second = await send();
      expect(second.body.data.id).toBe(first.body.data.id);
    });

    it('동시 요청도 멱등하다 — DB 유니크 인덱스가 최종 방어선', async () => {
      const send = () =>
        api()
          .post('/api/v1/attendance/records')
          .set('Authorization', SEOUL_NURSE)
          .send({
            recordType: 'CHECK_IN',
            location: { gps: { ...HOSPITAL, accuracy: 12 } },
            device: { deviceId: 'device_abc' },
            clientNonce: 'concurrent-key-1',
          });

      const [a, b] = await Promise.all([send(), send()]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(a.body.data.id).toBe(b.body.data.id);
    });

    it('지오펜스 밖이면 422지만 기록은 저장된다 — 막다른 길을 만들지 않는다', async () => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { gps: { lat: 37.55, lng: 127.11, accuracy: 12 } },
          device: { deviceId: 'device_abc' },
          clientNonce: 'far-away-1',
        })
        .expect(422);

      expect(res.body.error.code).toBe('LOCATION_UNVERIFIED');
      // 오류 응답에도 data가 온다. 앱이 "승인 대기"를 정확히 표시할 수 있어야 한다.
      expect(res.body.data.verification).toBe('PENDING_REVIEW');
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.error.message).toMatch(/떨어진/);
    });

    it('모의 위치는 승인되지 않지만 거부되지도 않는다', async () => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { gps: { ...HOSPITAL, accuracy: 5, isMock: true } },
          device: { deviceId: 'device_abc' },
          clientNonce: 'mock-1',
        })
        .expect(422);

      expect(res.body.data.verification).toBe('PENDING_REVIEW');
      expect(res.body.data.reason).toBe('MOCK_LOCATION');
      expect(res.body.data.verification).not.toBe('REJECTED');
    });

    it('미등록 기기는 승인 대기로 강등된다', async () => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { wifi: [{ bssid: 'a4:2b:8c:11:22:33' }] },
          device: {},
          clientNonce: 'no-device-1',
        })
        .expect(422);
      expect(res.body.data.reason).toBe('DEVICE_NOT_BOUND');
    });

    it('recordType 검증을 한다', async () => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({ recordType: 'TELEPORT' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('승인 대기 처리', () => {
    const createPending = async (nonce: string): Promise<string> => {
      const res = await api()
        .post('/api/v1/attendance/records')
        .set('Authorization', SEOUL_NURSE)
        .send({
          recordType: 'CHECK_IN',
          location: { gps: { lat: 37.56, lng: 127.12, accuracy: 12 } },
          device: { deviceId: 'device_abc' },
          clientNonce: nonce,
        })
        .expect(422);
      return res.body.data.id;
    };

    it('일반 구성원은 처리할 수 없다', async () => {
      const id = await createPending('pending-for-auth-test');
      const res = await api()
        .post(`/api/v1/attendance/pending-reviews/${id}/resolve`)
        .set('Authorization', SEOUL_NURSE)
        .send({ action: 'APPROVE', comment: '확인함' })
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('관리자는 사유를 남기고 승인할 수 있다', async () => {
      const id = await createPending('pending-approve-1');
      const res = await api()
        .post(`/api/v1/attendance/pending-reviews/${id}/resolve`)
        .set('Authorization', SEOUL_MANAGER)
        .send({ action: 'APPROVE', comment: '본관 지하 통신 불량 확인' })
        .expect(201);
      expect(res.body.data.verification).toBe('VERIFIED');
    });

    it('사유 없는 처리는 거부한다', async () => {
      const id = await createPending('pending-no-reason');
      await api()
        .post(`/api/v1/attendance/pending-reviews/${id}/resolve`)
        .set('Authorization', SEOUL_MANAGER)
        .send({ action: 'APPROVE', comment: '   ' })
        .expect(400);
    });
  });

  describe('근무표 규칙 평가', () => {
    const detail = () =>
      api().get(`/api/v1/rosters/${ROSTER_WARD3}`).set('Authorization', SEOUL_MANAGER).expect(200);

    it('시드 근무표에 심어둔 E→D 위반을 잡는다', async () => {
      const res = await detail();
      const codes = res.body.data.violations.map((v: { ruleCode: string }) => v.ruleCode);
      expect(codes).toContain('FORBIDDEN_SHIFT_PATTERN');
      expect(codes).toContain('MIN_REST_BETWEEN_SHIFTS');
    });

    it('위반에 근거 조문과 해결 방법이 함께 온다', async () => {
      const res = await detail();
      const rest = res.body.data.violations.find(
        (v: { ruleCode: string }) => v.ruleCode === 'MIN_REST_BETWEEN_SHIFTS',
      );
      expect(rest.legalBasis).toBe('근로기준법 제59조 제2항');
      expect(rest.suggestion).toBeTruthy();
      expect(rest.message).toContain('김간호');
    });

    it('특례 서면합의 사업장이라 52시간 규칙 대신 11시간 휴식 규칙이 걸린다', async () => {
      const res = await detail();
      expect(res.body.data.ruleSetVersions).toContain('kr-healthcare-exception-2026.1');
      const codes = res.body.data.violations.map((v: { ruleCode: string }) => v.ruleCode);
      expect(codes).not.toContain('WEEKLY_MAX_MINUTES');
    });

    it('야간시간은 나이트뿐 아니라 이브닝의 22~23시도 합산한다', async () => {
      const res = await detail();
      const kim = res.body.data.weekly.find((w: { memberId: string }) => w.memberId === MEM_KIM);
      // 나이트 2회 × 8시간(480) + 이브닝 1회의 22:00~23:00(60) = 1020분
      expect(kim.nightMinutes).toBe(1020);
    });

    it('BLOCK 위반이 있으면 확정을 막고 위반 내역을 돌려준다', async () => {
      const res = await api()
        .post(`/api/v1/rosters/${ROSTER_WARD3}/publish`)
        .set('Authorization', SEOUL_MANAGER)
        .send({})
        .expect(409);

      expect(res.body.error.code).toBe('RULE_VIOLATION');
      expect(res.body.error.details.length).toBeGreaterThan(0);
      expect(res.body.error.details[0].suggestion).toBeTruthy();
    });

    it('사유를 입력하면 강행 확정할 수 있다 — 막는 게 아니라 기록하는 게 목적', async () => {
      const res = await api()
        .post(`/api/v1/rosters/${ROSTER_WARD3}/publish`)
        .set('Authorization', SEOUL_MANAGER)
        .send({
          overrideViolations: [
            { ruleCode: 'FORBIDDEN_SHIFT_PATTERN', reason: '인력 부족으로 불가피, 원장 승인' },
            { ruleCode: 'MIN_REST_BETWEEN_SHIFTS', reason: '인력 부족으로 불가피, 원장 승인' },
          ],
        })
        .expect(201);
      expect(res.body.data.status).toBe('PUBLISHED');

      // 강행 사유가 감사 로그에 남는다.
      // 저장소는 어떤 경로로 불려도 테넌트 컨텍스트를 요구한다. 테스트도 예외가 아니다.
      const log = await runWithContext(
        {
          tenantId: TENANT_SEOUL,
          memberId: MEM_PARK,
          roles: ['WARD_MANAGER'],
          departmentScope: [],
          requestId: 'test-audit',
        },
        () => store.audit.list(),
      );
      const forced = log.filter((e) => e.entityType === 'ruleViolationOverride');
      expect(forced).toHaveLength(2);
      // 누가 강행했는지가 남아야 한다. 사유만 남고 사람이 없으면 감사 기록이 아니다.
      expect(forced[0]?.actorId).toBe(MEM_PARK);
      expect(forced.map((e) => e.reason).join('\n')).toContain('원장 승인');
    });
  });

  describe('휴가', () => {
    it('잔액과 소멸 예정을 함께 돌려준다', async () => {
      const res = await api()
        .get('/api/v1/leaves/me/balance?asOf=2026-07-29')
        .set('Authorization', SEOUL_NURSE)
        .expect(200);

      expect(res.body.data.annual.remaining).toBeGreaterThan(0);
      expect(Array.isArray(res.body.data.annual.expiringSoon)).toBe(true);
    });

    it('연차를 신청하면 소멸임박 건부터 차감된다', async () => {
      const before = await api()
        .get('/api/v1/leaves/me/balance?asOf=2026-08-12')
        .set('Authorization', SEOUL_NURSE)
        .expect(200);

      const res = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({
          leaveTypeId: LEAVE_TYPE_IDS.annual,
          startDate: '2026-08-12',
          endDate: '2026-08-13',
          reason: '가족 여행',
        })
        .expect(201);

      expect(res.body.data.days).toBe(2);
      expect(res.body.data.deductions.length).toBeGreaterThan(0);
      expect(res.body.data.balanceAfter.remaining).toBeCloseTo(
        before.body.data.annual.remaining - 2,
        2,
      );
    });

    it('잔액을 넘겨 신청하면 422와 함께 부족분을 알려준다', async () => {
      const res = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({
          leaveTypeId: LEAVE_TYPE_IDS.annual,
          startDate: '2026-09-01',
          endDate: '2026-12-31',
        })
        .expect(422);

      expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
      expect(res.body.error.details[0].availableDays).toBeDefined();
    });

    it('취소하면 잔액이 복원된다', async () => {
      const before = await api()
        .get('/api/v1/leaves/me/balance?asOf=2026-08-20')
        .set('Authorization', SEOUL_NURSE)
        .expect(200);

      const created = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({ leaveTypeId: LEAVE_TYPE_IDS.annual, startDate: '2026-08-20' })
        .expect(201);

      await api()
        .post(`/api/v1/leaves/requests/${created.body.data.id}/cancel`)
        .set('Authorization', SEOUL_NURSE)
        .expect(201);

      const after = await api()
        .get('/api/v1/leaves/me/balance?asOf=2026-08-20')
        .set('Authorization', SEOUL_NURSE)
        .expect(200);

      expect(after.body.data.annual.remaining).toBeCloseTo(
        before.body.data.annual.remaining,
        2,
      );
    });

    it('반차는 0.5일만 차감한다', async () => {
      const res = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({ leaveTypeId: LEAVE_TYPE_IDS.half, startDate: '2026-08-25', units: 50 })
        .expect(201);
      expect(res.body.data.days).toBe(0.5);
    });

    it('같은 부서 동료의 휴가가 겹치면 경고한다', async () => {
      await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_MANAGER)
        .send({ leaveTypeId: LEAVE_TYPE_IDS.annual, startDate: '2026-08-26' })
        .expect(201);

      const res = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({ leaveTypeId: LEAVE_TYPE_IDS.annual, startDate: '2026-08-26' })
        .expect(201);

      const warning = res.body.data.warnings.find(
        (w: { code: string }) => w.code === 'TEAM_COVERAGE',
      );
      expect(warning).toBeDefined();
      expect(warning.message).toContain('박수간');
    });

    it('잔액을 차감하지 않는 휴가 종류는 차감 내역이 없다', async () => {
      const res = await api()
        .post('/api/v1/leaves/requests')
        .set('Authorization', SEOUL_NURSE)
        .send({ leaveTypeId: LEAVE_TYPE_IDS.sick, startDate: '2026-11-02' })
        .expect(201);
      expect(res.body.data.deductions).toHaveLength(0);
    });
  });
});
