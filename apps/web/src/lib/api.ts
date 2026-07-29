/**
 * 코어 API 클라이언트.
 *
 * 개발 중에는 `dev` 토큰을 쓴다. 운영에서는 세션에서 꺼낸 JWT로 바꾼다 —
 * 토큰을 만드는 자리는 여기 한 곳뿐이므로 교체 지점도 한 곳이다.
 */

import type { RosterPlan, Violation } from '@mediwork/domain';

export interface RosterMemberView {
  readonly id: string;
  readonly name: string;
  readonly jobFamily: string;
}

export interface RosterDetailResponse {
  readonly id: string;
  readonly status: 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'LOCKED';
  readonly period: { readonly start: string; readonly end: string };
  readonly members: readonly RosterMemberView[];
  readonly violations: readonly Violation[];
  readonly ruleSetVersions: readonly string[];
  readonly plan: RosterPlan;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: readonly unknown[];
  };
}

export const API_BASE = process.env['NEXT_PUBLIC_API_BASE'] ?? 'http://localhost:3000';

/** 개발용 토큰. `NEXT_PUBLIC_DEV_AUTH`로 덮어쓸 수 있다. */
export const DEV_AUTH =
  process.env['NEXT_PUBLIC_DEV_AUTH'] ??
  'dev 11111111-1111-4111-8111-111111111111:11111111-1111-4111-8111-000000000202:WARD_MANAGER:device_park';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.error.message ?? `API 오류 (${status})`);
    this.name = 'ApiRequestError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: DEV_AUTH,
      ...init?.headers,
    },
  });

  const text = await res.text();
  const body = text === '' ? null : (JSON.parse(text) as { data?: T } & ApiErrorBody);
  if (!res.ok) throw new ApiRequestError(res.status, body);
  return (body as { data: T }).data;
}

export function fetchRoster(id: string): Promise<RosterDetailResponse> {
  return call<RosterDetailResponse>(`/api/v1/rosters/${id}`);
}

export function publishRoster(
  id: string,
  overrideViolations: readonly { ruleCode: string; reason: string }[],
): Promise<RosterDetailResponse> {
  return call<RosterDetailResponse>(`/api/v1/rosters/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify({ overrideViolations }),
  });
}
