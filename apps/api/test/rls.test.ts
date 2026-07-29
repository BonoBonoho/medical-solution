/**
 * Row Level Security 검증.
 *
 * 문서(docs/03-architecture.md §3.1, docs/10-security-compliance.md §4.3)에서
 * "애플리케이션 필터링만 믿지 않는다"고 했다. 이 파일은 그 주장을 실제로
 * 확인한다 — **애플리케이션이 WHERE 절을 빠뜨려도** 다른 테넌트의 행이
 * 보이지 않아야 한다.
 *
 * DATABASE_URL이 없으면 스킵한다.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/db/pool.js';
import { PgStore } from '../src/store/pg.store.js';
import { runWithContext } from '../src/common/tenant-context.js';
import { MEM_BUSAN, MEM_KIM, ROSTER_WARD3, TENANT_BUSAN, TENANT_SEOUL } from '../src/store/seed.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const DATABASE_ADMIN_URL = process.env['DATABASE_ADMIN_URL'];
const describeIfPg =
  DATABASE_URL === undefined || DATABASE_ADMIN_URL === undefined ? describe.skip : describe;

/** 애플리케이션 연결. 비-수퍼유저 롤이므로 RLS가 적용된다. */
let db: Db;
/** 마이그레이션·시드 전용. 스키마 소유자. */
let adminDb: Db;
let store: PgStore;

const asSeoul = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(
    {
      tenantId: TENANT_SEOUL,
      memberId: MEM_KIM,
      roles: ['MEMBER'],
      departmentScope: [],
      requestId: 'test',
    },
    fn,
  );

const asBusan = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(
    {
      tenantId: TENANT_BUSAN,
      memberId: MEM_BUSAN,
      roles: ['MEMBER'],
      departmentScope: [],
      requestId: 'test',
    },
    fn,
  );

describeIfPg('RLS 테넌트 격리', () => {
  beforeAll(async () => {
    db = new Db({ connectionString: DATABASE_URL! });
    adminDb = new Db({ connectionString: DATABASE_ADMIN_URL! });
    store = new PgStore(db, adminDb);
    await store.reset();
  }, 60_000);

  afterAll(async () => {
    await store.close();
  });

  it('WHERE 절 없이 전체 조회해도 자기 테넌트 행만 보인다', async () => {
    const seoulRows = await asSeoul(() =>
      db.withTenant(async (c) => (await c.query('SELECT id, name FROM member')).rows),
    );
    const busanRows = await asBusan(() =>
      db.withTenant(async (c) => (await c.query('SELECT id, name FROM member')).rows),
    );

    // 시드에는 서울 3명, 부산 1명이 있다. 쿼리에 tenant_id 조건이 없는데도 분리된다.
    expect(seoulRows).toHaveLength(3);
    expect(busanRows).toHaveLength(1);
    expect(busanRows[0].name).toBe('최간호');
    expect(seoulRows.map((r: { name: string }) => r.name)).not.toContain('최간호');
  });

  it('다른 테넌트의 행을 id로 직접 지목해도 조회되지 않는다', async () => {
    const rows = await asBusan(() =>
      db.withTenant(async (c) => (await c.query('SELECT id FROM member WHERE id = $1', [MEM_KIM])).rows),
    );
    expect(rows).toHaveLength(0);
  });

  it('다른 테넌트의 행은 UPDATE 되지 않는다', async () => {
    const result = await asBusan(() =>
      db.withTenant(async (c) =>
        c.query("UPDATE member SET name = '탈취됨' WHERE id = $1", [MEM_KIM]),
      ),
    );
    expect(result.rowCount).toBe(0);

    const kim = await asSeoul(() => store.members.findById(MEM_KIM));
    expect(kim?.name).toBe('김간호');
  });

  it('다른 테넌트의 행은 DELETE 되지 않는다', async () => {
    const result = await asBusan(() =>
      db.withTenant(async (c) => c.query('DELETE FROM roster WHERE id = $1', [ROSTER_WARD3])),
    );
    expect(result.rowCount).toBe(0);

    const roster = await asSeoul(() => store.rosters.findById(ROSTER_WARD3));
    expect(roster).not.toBeNull();
  });

  it('남의 tenant_id를 박아 INSERT하려 하면 WITH CHECK가 막는다', async () => {
    await expect(
      asBusan(() =>
        db.withTenant(async (c) =>
          c.query(
            `INSERT INTO holiday (tenant_id, holiday_date, name) VALUES ($1, '2026-12-25', '몰래삽입')`,
            [TENANT_SEOUL],
          ),
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('테넌트 컨텍스트가 없으면 아무 행도 보이지 않는다', async () => {
    // app.tenant_id 미설정 → app_current_tenant()가 NULL → 정책이 전부 거짓
    const rows = await db.withoutTenant(async (c) => (await c.query('SELECT id FROM member')).rows);
    expect(rows).toHaveLength(0);
  });

  it('테넌트 설정은 트랜잭션 스코프라 커넥션 재사용 시 남지 않는다', async () => {
    await asSeoul(() => db.withTenant(async (c) => c.query('SELECT 1')));
    // 같은 풀의 커넥션을 다시 빌려도 이전 테넌트 설정이 살아있으면 안 된다.
    const leaked = await db.withoutTenant(
      async (c) => (await c.query('SELECT id FROM member')).rows,
    );
    expect(leaked).toHaveLength(0);
  });

  it('애플리케이션 롤은 수퍼유저가 아니며 BYPASSRLS도 없다', async () => {
    // 이게 깨지면 위의 격리 테스트가 전부 무의미해진다.
    const row = await db.withoutTenant(async (c) => {
      const { rows } = await c.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      return rows[0];
    });
    expect(row.rolsuper).toBe(false);
    expect(row.rolbypassrls).toBe(false);
  });

  it('감사 로그는 애플리케이션 롤이 수정·삭제할 수 없다', async () => {
    const grants = await adminDb.withoutTenant(async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'mediwork_app' AND table_name = 'audit_log'`,
      );
      return rows.map((r: { privilege_type: string }) => r.privilege_type);
    });
    expect(grants).toContain('INSERT');
    expect(grants).toContain('SELECT');
    expect(grants).not.toContain('UPDATE');
    expect(grants).not.toContain('DELETE');
  });

  it('근태 원본은 애플리케이션 롤이 삭제할 수 없다', async () => {
    const grants = await adminDb.withoutTenant(async (c) => {
      const { rows } = await c.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE grantee = 'mediwork_app' AND table_name = 'attendance_record'`,
      );
      return rows.map((r: { privilege_type: string }) => r.privilege_type);
    });
    expect(grants).not.toContain('DELETE');
  });

  it('멱등성 유니크 인덱스가 동시 중복 삽입을 막는다', async () => {
    const insert = (): Promise<unknown> =>
      asSeoul(() =>
        db.withTenant(async (c) =>
          c.query(
            `INSERT INTO attendance_record
               (tenant_id, member_id, work_date, record_type, captured_at,
                verification, evidence, client_nonce)
             VALUES ($1,$2,'2026-08-03','CHECK_IN', now(), 'VERIFIED', '{}', 'race-nonce')`,
            [TENANT_SEOUL, MEM_KIM],
          ),
        ),
      );

    const results = await Promise.allSettled([insert(), insert()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
