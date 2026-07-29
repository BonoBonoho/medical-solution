/**
 * PostgreSQL 연결과 테넌트 컨텍스트 바인딩.
 *
 * 모든 질의는 `withTenant()`를 거친다. 이 함수가 트랜잭션을 열고
 * `SET LOCAL app.tenant_id`를 설정하므로, RLS 정책이 자동으로 적용된다.
 * 애플리케이션 코드가 WHERE 절을 빠뜨려도 다른 테넌트의 행은 보이지 않는다.
 */

import pg from 'pg';
import { tenantId } from '../common/tenant-context.js';

const { Pool } = pg;

// pg는 int8(bigint)을 문자열로 돌려준다. 감사 로그 id 정도라 숫자로 파싱한다.
pg.types.setTypeParser(20, (value: string) => Number(value));
// date는 로컬 타임존 Date로 파싱되면 하루가 밀린다. 문자열 그대로 받는다.
pg.types.setTypeParser(1082, (value: string) => value);

export type PoolClient = pg.PoolClient;

export interface DbConfig {
  readonly connectionString: string;
  readonly max?: number;
}

export class Db {
  private readonly pool: pg.Pool;

  constructor(config: DbConfig) {
    this.pool = new Pool({
      connectionString: config.connectionString,
      max: config.max ?? 10,
    });
  }

  /**
   * 테넌트 컨텍스트를 건 트랜잭션에서 콜백을 실행한다.
   *
   * `SET LOCAL`은 트랜잭션 스코프이므로 커밋/롤백과 함께 자동 해제된다.
   * 커넥션 풀에서 재사용될 때 이전 테넌트 설정이 남지 않는다.
   */
  async withTenant<T>(fn: (client: PoolClient) => Promise<T>, overrideTenantId?: string): Promise<T> {
    const tid = overrideTenantId ?? tenantId();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tid]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 테넌트 컨텍스트 없이 실행한다. 마이그레이션·시드 전용.
   *
   * ⚠️ 요청 처리 경로에서 절대 쓰지 말 것. RLS를 우회하게 된다.
   */
  async withoutTenant<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** PostgreSQL 고유 오류 코드. */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const err = error as { code?: string; constraint?: string };
  if (err.code !== PG_UNIQUE_VIOLATION) return false;
  return constraint === undefined || err.constraint === constraint;
}
