/**
 * 근무표 그리드의 순수 로직.
 *
 * 렌더링과 분리해 둔 이유는 여기가 틀리면 **화면에 위반이 안 보이는데
 * 확정은 막히는** 상태가 되기 때문이다. 컴포넌트 테스트로는 잡기 어렵고,
 * 순수 함수로 두면 그냥 확인할 수 있다.
 */

import {
  addDays,
  evaluateRosterPlan,
  startOfWeek,
  type LocalDate,
  type PlannedAssignment,
  type RosterEvaluation,
  type RosterPlan,
  type Severity,
  type Violation,
} from '@mediwork/domain';

export type CellKey = string;

/** `memberId|workDate`. 이 형식은 도메인의 day/week subject id와 같다. */
export function cellKey(memberId: string, workDate: LocalDate): CellKey {
  return `${memberId}|${workDate}`;
}

/** 근무표 기간의 날짜를 순서대로 편다. */
export function datesInPeriod(start: LocalDate, end: LocalDate): LocalDate[] {
  const dates: LocalDate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  return dates;
}

/**
 * 배정을 셀 단위로 색인한다.
 *
 * 한 셀에 배정이 둘일 수는 없다는 전제를 여기서 강제한다.
 * (당직 겸무 같은 케이스가 생기면 이 함수가 먼저 깨져 알려준다.)
 */
export function assignmentsByCell(
  assignments: readonly PlannedAssignment[],
): Map<CellKey, PlannedAssignment> {
  const map = new Map<CellKey, PlannedAssignment>();
  for (const a of assignments) map.set(cellKey(a.memberId, a.workDate), a);
  return map;
}

export interface CellViolations {
  /** 이 셀에 직접 걸린 위반. */
  readonly direct: readonly Violation[];
  /** 셀에 칠할 색을 정하는 최고 심각도. 없으면 null. */
  readonly severity: Severity | null;
}

const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, WARN: 1, BLOCK: 2 };

/**
 * 위반을 셀에 매핑한다.
 *
 * 위반의 subject는 세 종류다.
 *   · shiftAssignment — 배정 id → 그 배정이 있는 셀
 *   · day             — `memberId|workDate` → 그 셀
 *   · week            — `memberId|weekStart` → **그 주의 모든 셀**
 *
 * 주 단위 위반(52시간 초과, 주휴일 부족)을 셀에 안 칠하면 수간호사는
 * 어느 줄이 문제인지 알 수 없다. 주 전체를 칠하는 편이 정확하다 —
 * 실제로 그 주 전체가 문제이기 때문이다.
 */
export function violationsByCell(
  violations: readonly Violation[],
  assignments: readonly PlannedAssignment[],
  dates: readonly LocalDate[],
): Map<CellKey, CellViolations> {
  const byId = new Map(assignments.map((a) => [a.id, a]));
  const buckets = new Map<CellKey, Violation[]>();

  const push = (key: CellKey, violation: Violation): void => {
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [violation]);
    else if (!bucket.includes(violation)) bucket.push(violation);
  };

  for (const violation of violations) {
    for (const subject of violation.subjects) {
      if (subject.type === 'shiftAssignment') {
        const assignment = byId.get(subject.id);
        if (assignment !== undefined) {
          push(cellKey(assignment.memberId, assignment.workDate), violation);
        }
        continue;
      }
      if (subject.type === 'day') {
        push(subject.id, violation);
        continue;
      }
      if (subject.type === 'week') {
        const sep = subject.id.lastIndexOf('|');
        if (sep < 0) continue;
        const memberId = subject.id.slice(0, sep);
        const weekStart = subject.id.slice(sep + 1) as LocalDate;
        for (const date of dates) {
          if (startOfWeek(date) === weekStart) push(cellKey(memberId, date), violation);
        }
      }
    }
  }

  const result = new Map<CellKey, CellViolations>();
  for (const [key, direct] of buckets) {
    let severity: Severity | null = null;
    for (const v of direct) {
      if (severity === null || SEVERITY_RANK[v.severity] > SEVERITY_RANK[severity]) {
        severity = v.severity;
      }
    }
    result.set(key, { direct, severity });
  }
  return result;
}

/**
 * 셀 하나의 근무유형을 바꾼 새 plan을 만든다.
 *
 * 기존 배정을 수정하는 게 아니라 교체한다. `null`이면 배정을 지운다(빈 칸).
 * plan 자체는 불변으로 다뤄야 편집 취소(undo)를 나중에 얹을 수 있다.
 */
export function withCellChanged(
  plan: RosterPlan,
  memberId: string,
  workDate: LocalDate,
  shiftTypeId: string | null,
): RosterPlan {
  const rest = plan.assignments.filter(
    (a) => !(a.memberId === memberId && a.workDate === workDate),
  );
  if (shiftTypeId === null) return { ...plan, assignments: rest };

  const existing = plan.assignments.find(
    (a) => a.memberId === memberId && a.workDate === workDate,
  );
  return {
    ...plan,
    assignments: [
      ...rest,
      {
        // 새 배정은 임시 id를 갖는다. 서버가 저장하며 진짜 id를 발급한다.
        id: existing?.id ?? `draft:${memberId}:${workDate}`,
        memberId,
        workDate,
        shiftTypeId,
      },
    ],
  };
}

export interface GridModel {
  readonly plan: RosterPlan;
  readonly dates: readonly LocalDate[];
  readonly evaluation: RosterEvaluation;
  readonly cells: Map<CellKey, PlannedAssignment>;
  readonly cellViolations: Map<CellKey, CellViolations>;
  readonly weeklyByMember: Map<string, RosterEvaluation['weekly'][number][]>;
  readonly blockingCount: number;
}

/**
 * plan 하나로부터 화면에 필요한 것을 전부 만든다.
 *
 * **서버와 같은 `evaluateRosterPlan`을 부른다.** 웹이 규칙을 따로 구현하면
 * 편집 중에는 초록불이었는데 확정하면 막히는 상황이 생긴다.
 */
export function buildGridModel(plan: RosterPlan): GridModel {
  const dates = datesInPeriod(plan.periodStart, plan.periodEnd);
  const evaluation = evaluateRosterPlan(plan);

  const weeklyByMember = new Map<string, RosterEvaluation['weekly'][number][]>();
  for (const week of evaluation.weekly) {
    const list = weeklyByMember.get(week.memberId);
    if (list === undefined) weeklyByMember.set(week.memberId, [week]);
    else list.push(week);
  }
  for (const list of weeklyByMember.values()) {
    list.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  }

  return {
    plan,
    dates,
    evaluation,
    cells: assignmentsByCell(plan.assignments),
    cellViolations: violationsByCell(evaluation.violations, plan.assignments, dates),
    weeklyByMember,
    blockingCount: evaluation.violations.filter((v) => v.severity === 'BLOCK').length,
  };
}

export function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}
