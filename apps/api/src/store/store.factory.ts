import { Db } from '../db/pool.js';
import { MemoryStore } from './memory.store.js';
import { PgStore } from './pg.store.js';
import type { Store } from './ports.js';

/**
 * 저장소 선택.
 *
 * `DATABASE_URL`이 있으면 PostgreSQL, 없으면 인메모리를 쓴다.
 * 두 구현은 같은 e2e 테스트를 통과하므로 어느 쪽이든 동작이 같다.
 *
 * ⚠️ `DATABASE_URL`은 반드시 **비-수퍼유저 롤**(mediwork_app)을 가리켜야 한다.
 * 수퍼유저로 접속하면 RLS가 조용히 우회된다.
 * 마이그레이션은 `DATABASE_ADMIN_URL`(스키마 소유자)로 따로 실행한다.
 */
export function createStore(options: {
  databaseUrl?: string | undefined;
  adminUrl?: string | undefined;
} = {}): Store {
  const url = options.databaseUrl ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') return new MemoryStore();

  const adminUrl = options.adminUrl ?? process.env['DATABASE_ADMIN_URL'];
  return new PgStore(
    new Db({ connectionString: url }),
    adminUrl === undefined || adminUrl === '' ? undefined : new Db({ connectionString: adminUrl }),
  );
}
