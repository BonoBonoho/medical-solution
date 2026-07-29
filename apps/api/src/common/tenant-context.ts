import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 요청별 테넌트 컨텍스트.
 *
 * 클라이언트가 보낸 tenantId는 절대 신뢰하지 않는다. 토큰에서 해석한 값만
 * 여기에 담고, 저장소 계층은 이 값으로만 스코프를 건다.
 *
 * 운영에서는 이 값이 `SET LOCAL app.tenant_id`로 이어져 PostgreSQL RLS가
 * 최종 방어선이 된다. 애플리케이션 필터링만 믿지 않는 이유는
 * 실수 한 번이 다른 병원의 인사 데이터 노출로 이어지기 때문이다.
 * (docs/03-architecture.md §3.1)
 */
export interface RequestContext {
  readonly tenantId: string;
  readonly memberId: string;
  readonly roles: readonly string[];
  /** 접근 가능한 부서 경로. 조직 트리 기준 스코프. */
  readonly departmentScope: readonly string[];
  readonly deviceId?: string;
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error(
      '테넌트 컨텍스트가 없습니다. 인증 미들웨어를 거치지 않은 경로입니다.',
    );
  }
  return context;
}

export function tenantId(): string {
  return currentContext().tenantId;
}

export function hasRole(role: string): boolean {
  return currentContext().roles.includes(role);
}
