/**
 * 근무표 한 장을 통째로 평가한다.
 *
 * 이 함수가 도메인 패키지에 있는 이유가 제품의 핵심이다.
 *
 * 근무표 그리드는 셀 하나를 바꿀 때마다 **즉시** 위반을 다시 보여줘야 한다.
 * 서버 왕복을 기다리면 수간호사가 30명 × 31칸을 편집하는 동안 응답을 900번
 * 기다리게 되고, 그러면 아무도 쓰지 않는다. 그렇다고 웹이 계산을 따로
 * 구현하면 화면의 위반 표시와 확정 시 서버 판정이 갈라진다 — 편집 중에는
 * 초록불이었는데 저장하면 막히는, 최악의 종류의 버그다.
 *
 * 그래서 계산은 여기 한 벌만 두고 서버와 웹이 같은 함수를 부른다.
 * 서버는 DB에서 읽은 데이터로, 웹은 서버가 내려준 같은 데이터로 부른다.
 * (docs/03-architecture.md §8.1)
 */

import type { LocalDate } from '../time/interval.js';
import { resolveShiftInterval, type ShiftType } from '../time/shift.js';
import { computeDailyWorktime, type DailyWorktime } from '../worktime/daily.js';
import { aggregateWeekly, type WeeklyWorktime } from '../worktime/weekly.js';
import { evaluateRules } from '../rules/engine.js';
import type {
  EvaluatedShift,
  EvaluationBasis,
  RuleMember,
  RuleSet,
  Violation,
} from '../rules/types.js';

/** 근무유형 정의에 식별자를 붙인 것. 배정이 이 id를 참조한다. */
export interface IdentifiedShiftType extends ShiftType {
  readonly id: string;
}

export interface PlannedAssignment {
  readonly id: string;
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly shiftTypeId: string;
}

export interface RosterPlan {
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly members: readonly RuleMember[];
  readonly shiftTypes: readonly IdentifiedShiftType[];
  readonly assignments: readonly PlannedAssignment[];
  /** 공휴일·약정휴일. 휴일근로 가산 판정에 쓴다. */
  readonly holidays: readonly LocalDate[];
  /**
   * 사업장별 적용 규칙 세트.
   *
   * 사업장마다 특례 서면합의 여부가 다르므로 하나로 합칠 수 없다.
   * 어떤 규칙이 적용되는지는 호출부가 결정한다 — 도메인은 판단하지 않는다.
   */
  readonly ruleSetsByWorksite: Readonly<Record<string, readonly RuleSet[]>>;
  /** 기본값 `'PLANNED'`. 실적 평가는 출퇴근 기록으로 따로 부른다. */
  readonly basis?: EvaluationBasis;
}

export interface RosterEvaluation {
  readonly shifts: readonly EvaluatedShift[];
  readonly daily: readonly DailyWorktime[];
  readonly weekly: readonly WeeklyWorktime[];
  readonly violations: readonly Violation[];
  readonly appliedRuleSetVersions: readonly string[];
}

export function evaluateRosterPlan(plan: RosterPlan): RosterEvaluation {
  const shiftTypes = new Map(plan.shiftTypes.map((s) => [s.id, s]));
  const holidays = new Set(plan.holidays);
  const basis = plan.basis ?? 'PLANNED';

  const shifts: EvaluatedShift[] = [];
  const daily: DailyWorktime[] = [];

  for (const assignment of plan.assignments) {
    const shiftType = shiftTypes.get(assignment.shiftTypeId);
    // 알 수 없는 근무유형은 건너뛴다. 편집 중인 그리드에서는 흔한 중간 상태다.
    if (shiftType === undefined) continue;

    const interval = resolveShiftInterval({
      id: assignment.id,
      memberId: assignment.memberId,
      workDate: assignment.workDate,
      shiftType,
    });

    shifts.push({
      id: assignment.id,
      memberId: assignment.memberId,
      workDate: assignment.workDate,
      shiftCode: shiftType.code,
      shiftName: shiftType.name,
      interval,
      isNight: shiftType.isNight,
      isWorking:
        shiftType.countsAsWork &&
        shiftType.category !== 'OFF' &&
        shiftType.category !== 'LEAVE',
    });

    daily.push(
      computeDailyWorktime({
        memberId: assignment.memberId,
        workDate: assignment.workDate,
        interval,
        breakMinutes: shiftType.breakMinutes,
        isHoliday: holidays.has(assignment.workDate),
        dutyMode: shiftType.dutyMode,
        dutyRatio: shiftType.dutyRatio,
        paidMinutesOverride: shiftType.paidMinutesOverride,
      }),
    );
  }

  const weekly = aggregateWeekly(daily);

  // 규칙 평가 입력은 구성원별로 다시 만들지 않는다. 평가기가 memberId로
  // 필터링하므로 전체를 넘겨도 결과가 같고, 31일 × 30명에서 반복 생성 비용이 크다.
  const data = {
    shifts,
    dailies: daily.map((d) => ({
      memberId: d.memberId,
      workDate: d.workDate,
      paidMinutes: d.paidMinutes,
      breakMinutes: d.breakMinutes,
    })),
    weeklies: weekly.map((w) => ({
      memberId: w.memberId,
      weekStart: w.weekStart,
      totalMinutes: w.totalMinutes,
      offDays: w.offDays,
    })),
  };

  const violations: Violation[] = [];
  const versions = new Set<string>();

  // 구성원별로 평가한다. 규칙 스코프가 직군·고용형태별로 다르기 때문이다.
  for (const member of plan.members) {
    const ruleSets = plan.ruleSetsByWorksite[member.worksiteId] ?? [];
    for (const rs of ruleSets) versions.add(rs.version);

    const result = evaluateRules(
      ruleSets,
      {
        member,
        periodStart: plan.periodStart,
        periodEnd: plan.periodEnd,
        basis,
      },
      data,
    );
    violations.push(...result.violations);
  }

  return {
    shifts,
    daily,
    weekly,
    violations,
    appliedRuleSetVersions: [...versions].sort(),
  };
}
