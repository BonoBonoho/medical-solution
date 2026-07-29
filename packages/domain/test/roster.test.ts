/**
 * 근무표 전체 평가.
 *
 * 이 함수의 존재 이유는 "서버와 웹이 같은 계산을 한다"는 것이므로,
 * 테스트도 그 성질을 확인하는 데 집중한다.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_SETS,
  evaluateRosterPlan,
  type IdentifiedShiftType,
  type PlannedAssignment,
  type RosterPlan,
  ruleSetsWithHealthcareException,
  type RuleMember,
} from '../src/index.js';

const WORKSITE = 'ws1';

const SHIFT_TYPES: IdentifiedShiftType[] = [
  {
    id: 'st-d',
    code: 'D',
    name: '데이',
    category: 'WORK',
    startTime: '07:00',
    endTime: '15:00',
    breakMinutes: 60,
    paidMinutesOverride: null,
    countsAsWork: true,
    dutyMode: null,
    dutyRatio: null,
    isNight: false,
  },
  {
    id: 'st-e',
    code: 'E',
    name: '이브닝',
    category: 'WORK',
    startTime: '15:00',
    endTime: '23:00',
    breakMinutes: 60,
    paidMinutesOverride: null,
    countsAsWork: true,
    dutyMode: null,
    dutyRatio: null,
    isNight: false,
  },
  {
    id: 'st-n',
    code: 'N',
    name: '나이트',
    category: 'WORK',
    startTime: '22:00',
    endTime: '08:00',
    breakMinutes: 120,
    paidMinutesOverride: null,
    countsAsWork: true,
    dutyMode: null,
    dutyRatio: null,
    isNight: true,
  },
  {
    id: 'st-o',
    code: 'O',
    name: '오프',
    category: 'OFF',
    startTime: null,
    endTime: null,
    breakMinutes: 0,
    paidMinutesOverride: null,
    countsAsWork: false,
    dutyMode: null,
    dutyRatio: null,
    isNight: false,
  },
];

const NURSE: RuleMember = {
  id: 'm1',
  name: '김간호',
  worksiteId: WORKSITE,
  jobFamily: 'NURSE',
  employmentType: 'REGULAR',
};

const DATES = [
  '2026-08-03',
  '2026-08-04',
  '2026-08-05',
  '2026-08-06',
  '2026-08-07',
  '2026-08-08',
  '2026-08-09',
] as const;

const CODE_TO_SHIFT_TYPE: Record<string, string> = {
  D: 'st-d',
  E: 'st-e',
  N: 'st-n',
  O: 'st-o',
};

function assignmentsFrom(pattern: readonly string[]): PlannedAssignment[] {
  return pattern.map((code, i) => ({
    id: `a${i}`,
    memberId: NURSE.id,
    workDate: DATES[i]!,
    shiftTypeId: CODE_TO_SHIFT_TYPE[code]!,
  }));
}

function planWith(pattern: readonly string[]): RosterPlan {
  return {
    periodStart: DATES[0],
    periodEnd: DATES[6],
    members: [NURSE],
    shiftTypes: SHIFT_TYPES,
    assignments: assignmentsFrom(pattern),
    holidays: [],
    ruleSetsByWorksite: { [WORKSITE]: DEFAULT_RULE_SETS },
  };
}

describe('evaluateRosterPlan', () => {
  it('E 다음 날 D는 금지 패턴 위반이다', () => {
    // 이브닝(~23:00) 종료 후 8시간 뒤 데이(07:00) 시작 = 퀵리턴
    const result = evaluateRosterPlan(planWith(['D', 'D', 'O', 'O', 'E', 'D', 'O']));
    expect(result.violations.map((v) => v.ruleCode)).toContain('FORBIDDEN_SHIFT_PATTERN');
  });

  it('11시간 연속휴식은 특례 서면합의가 있는 사업장에서만 걸린다', () => {
    // 특례는 "시간 한도"의 예외를 주는 대신 연속휴식 의무를 지운다.
    // 합의가 없는 사업장에 이 규칙을 임의로 적용하면 안 된다.
    const pattern = ['D', 'D', 'O', 'O', 'E', 'D', 'O'];
    const base = planWith(pattern);

    const withoutAgreement = evaluateRosterPlan(base).violations.map((v) => v.ruleCode);
    expect(withoutAgreement).not.toContain('MIN_REST_BETWEEN_SHIFTS');

    const withAgreement = evaluateRosterPlan({
      ...base,
      ruleSetsByWorksite: {
        [WORKSITE]: ruleSetsWithHealthcareException(WORKSITE, '2026-01-01', '2026-12-31'),
      },
    }).violations.map((v) => v.ruleCode);
    expect(withAgreement).toContain('MIN_REST_BETWEEN_SHIFTS');
    // 특례가 켜지면 주 52시간 한도 규칙은 꺼진다.
    expect(withAgreement).not.toContain('WEEKLY_MAX_MINUTES');
  });

  it('여유 있는 근무표는 위반이 없다', () => {
    const result = evaluateRosterPlan(planWith(['D', 'D', 'O', 'D', 'D', 'O', 'O']));
    expect(result.violations.filter((v) => v.severity === 'BLOCK')).toHaveLength(0);
  });

  it('야간시간은 나이트뿐 아니라 이브닝의 22~23시도 합산한다', () => {
    const result = evaluateRosterPlan(planWith(['E', 'O', 'N', 'O', 'O', 'O', 'O']));
    const total = result.weekly.reduce((sum, w) => sum + w.nightMinutes, 0);
    // 이브닝 22:00~23:00(60) + 나이트 22:00~08:00 중 야간(22~06 = 480)
    expect(total).toBe(540);
  });

  it('같은 입력이면 몇 번을 돌려도 같은 결과다 — 서버와 웹이 갈라지지 않는 근거', () => {
    // 순수 함수라는 성질이 이 제품에서 갖는 의미: 그리드에 표시된 위반과
    // 확정 시 서버가 판정하는 위반이 반드시 일치한다.
    const plan = planWith(['D', 'D', 'N', 'N', 'E', 'D', 'O']);
    const a = evaluateRosterPlan(plan);
    const b = evaluateRosterPlan(plan);
    expect(JSON.stringify(b.violations)).toBe(JSON.stringify(a.violations));
    expect(JSON.stringify(b.weekly)).toBe(JSON.stringify(a.weekly));
  });

  it('배정 순서가 달라도 결과가 같다 — 저장소 정렬에 의존하지 않는다', () => {
    const plan = planWith(['D', 'D', 'N', 'N', 'E', 'D', 'O']);
    const shuffled: RosterPlan = {
      ...plan,
      assignments: [...plan.assignments].reverse(),
    };

    const sortByKey = (v: { ruleCode: string; message: string }): string =>
      `${v.ruleCode}|${v.message}`;
    const codes = (p: RosterPlan): string[] =>
      evaluateRosterPlan(p).violations.map(sortByKey).sort();

    expect(codes(shuffled)).toEqual(codes(plan));
  });

  it('알 수 없는 근무유형은 무시한다 — 편집 중인 그리드의 중간 상태', () => {
    const plan = planWith(['D', 'D', 'O', 'O', 'O', 'O', 'O']);
    const withUnknown: RosterPlan = {
      ...plan,
      assignments: [
        ...plan.assignments,
        { id: 'ax', memberId: NURSE.id, workDate: '2026-08-05', shiftTypeId: 'st-없음' },
      ],
    };
    expect(() => evaluateRosterPlan(withUnknown)).not.toThrow();
    expect(evaluateRosterPlan(withUnknown).shifts).toHaveLength(plan.assignments.length);
  });

  it('사업장에 규칙 세트가 없으면 위반도 없다 — 임의 기본값을 적용하지 않는다', () => {
    // 규칙이 없는데 "그래도 52시간은 봐줘야지" 하고 기본값을 끼워넣으면
    // 기관이 설정한 적 없는 규칙으로 근무표가 막힌다.
    const plan: RosterPlan = { ...planWith(['N', 'N', 'N', 'N', 'N', 'N', 'N']), ruleSetsByWorksite: {} };
    const result = evaluateRosterPlan(plan);
    expect(result.violations).toHaveLength(0);
    expect(result.appliedRuleSetVersions).toHaveLength(0);
    // 계산 자체는 여전히 이뤄진다.
    expect(result.weekly.length).toBeGreaterThan(0);
  });
});
