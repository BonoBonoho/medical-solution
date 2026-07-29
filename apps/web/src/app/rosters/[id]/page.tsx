/**
 * 근무표 화면.
 *
 * 서버 컴포넌트에서 API를 부르고, 실패하면 샘플 데이터로 넘어간다.
 * 실패를 조용히 감추지 않고 화면에 사유를 함께 표시한다 — "왜 내 데이터가
 * 아니지"를 디버깅하게 만들지 않기 위해서다.
 */

import type { JSX } from 'react';
import RosterGrid from '@/components/RosterGrid';
import { fetchRoster } from '@/lib/api';
import { SAMPLE_PLAN } from '@/lib/sample';

export const dynamic = 'force-dynamic';

export default async function RosterPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<JSX.Element> {
  const { id } = await params;

  try {
    const roster = await fetchRoster(id);
    return (
      <RosterGrid
        initialPlan={roster.plan}
        rosterId={roster.id}
        status={roster.status}
        usingSample={false}
      />
    );
  } catch (error) {
    return (
      <RosterGrid
        initialPlan={SAMPLE_PLAN}
        rosterId={null}
        status="DRAFT"
        usingSample
        sampleReason={error instanceof Error ? error.message : undefined}
      />
    );
  }
}
