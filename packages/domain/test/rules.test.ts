import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULE_SETS,
  KR_GENERAL_2026,
  KR_HEALTHCARE_EXCEPTION_2026,
  KR_NURSING_SHIFT_2026,
  evaluateRules,
  hasBlockingViolations,
  localDateTime,
  resolveRules,
  ruleSetsWithHealthcareException,
  summarizeViolations,
  type EvaluatedShift,
  type RuleContext,
  type RuleEvaluationData,
} from '../src/index.js';

const context = (over: Partial<RuleContext> = {}): RuleContext => ({
  member: {
    id: 'm1',
    name: '김간호',
    worksiteId: 'w1',
    jobFamily: 'NURSE',
    employmentType: 'REGULAR',
  },
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  basis: 'PLANNED',
  ...over,
});

const SHIFTS = {
  D: { start: '07:00', end: '15:00', name: '데이', night: false },
  E: { start: '15:00', end: '23:00', name: '이브닝', night: false },
  N: { start: '22:00', end: '08:00', name: '나이트', night: true },
} as const;

function shift(
  workDate: string,
  code: keyof typeof SHIFTS | 'O',
  memberId = 'm1',
): EvaluatedShift {
  if (code === 'O') {
    return {
      id: `${memberId}-${workDate}`,
      memberId,
      workDate,
      shiftCode: 'O',
      shiftName: '오프',
      interval: null,
      isNight: false,
      isWorking: false,
    };
  }
  const spec = SHIFTS[code];
  const crosses = spec.end <= spec.start;
  const endDate = crosses
    ? new Date(Date.parse(`${workDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    : workDate;
  return {
    id: `${memberId}-${workDate}`,
    memberId,
    workDate,
    shiftCode: code,
    shiftName: spec.name,
    interval: {
      start: localDateTime(workDate, spec.start),
      end: localDateTime(endDate, spec.end),
    },
    isNight: spec.night,
    isWorking: true,
  };
}

const data = (over: Partial<RuleEvaluationData> = {}): RuleEvaluationData => ({
  shifts: [],
  dailies: [],
  weeklies: [],
  ...over,
});

describe('RuleSet 해석', () => {
  it('시행일 이전 규칙은 적용하지 않는다', () => {
    const resolved = resolveRules(
      [{ ...KR_GENERAL_2026, effectiveFrom: '2027-01-01' }],
      context(),
    );
    expect(resolved.size).toBe(0);
  });

  it('종료된 규칙은 적용하지 않는다', () => {
    const resolved = resolveRules(
      [{ ...KR_GENERAL_2026, effectiveTo: '2026-06-30' }],
      context(),
    );
    expect(resolved.size).toBe(0);
  });

  it('직군 스코프가 맞지 않으면 적용하지 않는다', () => {
    const resolved = resolveRules(
      DEFAULT_RULE_SETS,
      context({
        member: {
          id: 'm2',
          name: '박행정',
          worksiteId: 'w1',
          jobFamily: 'ADMIN',
          employmentType: 'REGULAR',
        },
      }),
    );
    // 간호 전용 규칙(FORBIDDEN_SHIFT_PATTERN 등)은 빠진다
    expect(resolved.has('FORBIDDEN_SHIFT_PATTERN')).toBe(false);
    expect(resolved.has('WEEKLY_MAX_MINUTES')).toBe(true);
  });

  it('간호사에게는 간호 전용 규칙이 추가된다', () => {
    const resolved = resolveRules(DEFAULT_RULE_SETS, context());
    expect(resolved.has('MAX_CONSECUTIVE_NIGHTS')).toBe(true);
  });

  it('우선순위가 높은 규칙 세트가 덮어쓴다 — 특례 적용 시 52시간 규칙이 꺼진다', () => {
    const sets = ruleSetsWithHealthcareException('w1', '2026-01-01', '2026-12-31');
    const resolved = resolveRules(sets, context());
    expect(resolved.has('WEEKLY_MAX_MINUTES')).toBe(false);
    expect(resolved.has('MIN_REST_BETWEEN_SHIFTS')).toBe(true);
    expect(resolved.get('MIN_REST_BETWEEN_SHIFTS')!.severity).toBe('BLOCK');
  });

  it('서면합의가 만료되면 특례가 꺼지고 52시간 규칙이 되살아난다', () => {
    const sets = ruleSetsWithHealthcareException('w1', '2025-01-01', '2025-12-31');
    const resolved = resolveRules(sets, context());
    expect(resolved.has('WEEKLY_MAX_MINUTES')).toBe(true);
    expect(resolved.has('MIN_REST_BETWEEN_SHIFTS')).toBe(false);
  });

  it('다른 사업장의 특례는 적용되지 않는다', () => {
    const sets = ruleSetsWithHealthcareException('w2', '2026-01-01', '2026-12-31');
    const resolved = resolveRules(sets, context());
    expect(resolved.has('WEEKLY_MAX_MINUTES')).toBe(true);
  });
});

describe('WEEKLY_MAX_MINUTES', () => {
  it('52시간 이하는 위반이 아니다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ weeklies: [{ memberId: 'm1', weekStart: '2026-08-03', totalMinutes: 3120, offDays: 1 }] }),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('초과 시 초과분을 메시지에 담는다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ weeklies: [{ memberId: 'm1', weekStart: '2026-08-03', totalMinutes: 3300, offDays: 1 }] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'WEEKLY_MAX_MINUTES');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('BLOCK');
    expect(v!.message).toContain('3시간 초과');
    expect(v!.legalBasis).toBe('근로기준법 제50조·제53조');
    expect(v!.suggestion).toBeTruthy();
    expect(v!.detail['excessMinutes']).toBe(180);
  });

  it('적용된 규칙 세트 버전을 기록한다 — 나중에 재현할 수 있어야 한다', () => {
    const result = evaluateRules([KR_GENERAL_2026], context(), data());
    expect(result.appliedRuleSetVersions).toContain('kr-general-2026.1');
  });
});

describe('MIN_REST_BETWEEN_SHIFTS (11시간)', () => {
  const sets = ruleSetsWithHealthcareException('w1', '2026-01-01', '2026-12-31');

  it('E → D 는 휴식 8시간으로 위반이다 (퀵 리턴)', () => {
    const result = evaluateRules(
      sets,
      context(),
      data({ shifts: [shift('2026-08-03', 'E'), shift('2026-08-04', 'D')] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'MIN_REST_BETWEEN_SHIFTS');
    expect(v).toBeDefined();
    expect(v!.detail['restMinutes']).toBe(480);
    expect(v!.message).toContain('8시간');
    expect(v!.legalBasis).toBe('근로기준법 제59조 제2항');
  });

  it('N → D 는 휴식 23시간으로 위반이 아니다', () => {
    const result = evaluateRules(
      sets,
      context(),
      data({ shifts: [shift('2026-08-03', 'N'), shift('2026-08-05', 'D')] }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'MIN_REST_BETWEEN_SHIFTS')).toHaveLength(0);
  });

  it('D → E 같은 날 연속은 휴식 0시간으로 위반이다', () => {
    const result = evaluateRules(
      sets,
      context(),
      data({ shifts: [shift('2026-08-03', 'D'), shift('2026-08-03', 'E')] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'MIN_REST_BETWEEN_SHIFTS');
    expect(v!.detail['restMinutes']).toBe(0);
  });

  it('D → D 는 휴식 16시간으로 위반이 아니다', () => {
    const result = evaluateRules(
      sets,
      context(),
      data({ shifts: [shift('2026-08-03', 'D'), shift('2026-08-04', 'D')] }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'MIN_REST_BETWEEN_SHIFTS')).toHaveLength(0);
  });
});

describe('FORBIDDEN_SHIFT_PATTERN', () => {
  it('E → D 패턴을 잡는다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({ shifts: [shift('2026-08-03', 'E'), shift('2026-08-04', 'D')] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'FORBIDDEN_SHIFT_PATTERN');
    expect(v).toBeDefined();
    expect(v!.severity).toBe('BLOCK');
  });

  it('연속하지 않는 날짜는 패턴으로 보지 않는다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({ shifts: [shift('2026-08-03', 'E'), shift('2026-08-05', 'D')] }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'FORBIDDEN_SHIFT_PATTERN')).toHaveLength(0);
  });

  // 회귀 테스트: 코드만으로 Map을 키잉하면 N→E가 E→D를 덮어써서
  // 두 규칙 중 하나가 조용히 사라졌다. instanceKey로 분리한다.
  it('같은 코드의 여러 인스턴스가 모두 살아있다', () => {
    const resolved = resolveRules([KR_NURSING_SHIFT_2026], context());
    const patternRules = [...resolved.values()].filter(
      (r) => r.code === 'FORBIDDEN_SHIFT_PATTERN',
    );
    expect(patternRules).toHaveLength(2);
  });

  it('N → E 패턴도 잡는다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({ shifts: [shift('2026-08-03', 'N'), shift('2026-08-04', 'E')] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'FORBIDDEN_SHIFT_PATTERN');
    expect(v).toBeDefined();
    expect(v!.detail['pattern']).toEqual(['N', 'E']);
  });

  it('상위 우선순위 규칙 세트가 같은 instanceKey로 특정 인스턴스만 끌 수 있다', () => {
    const resolved = resolveRules(
      [
        KR_NURSING_SHIFT_2026,
        {
          ...KR_NURSING_SHIFT_2026,
          id: 'override',
          version: 'override',
          priority: 999,
          rules: [
            {
              code: 'FORBIDDEN_SHIFT_PATTERN' as const,
              instanceKey: 'E-D',
              params: {},
              severity: 'INFO' as const,
              enabled: false,
            },
          ],
        },
      ],
      context(),
    );
    const patternRules = [...resolved.values()].filter(
      (r) => r.code === 'FORBIDDEN_SHIFT_PATTERN',
    );
    expect(patternRules).toHaveLength(1);
    expect(patternRules[0]!.instanceKey).toBe('N-E');
  });
});

describe('MAX_CONSECUTIVE_NIGHTS', () => {
  it('3연속까지는 허용이다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({
        shifts: [
          shift('2026-08-03', 'N'),
          shift('2026-08-04', 'N'),
          shift('2026-08-05', 'N'),
          shift('2026-08-06', 'O'),
        ],
      }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'MAX_CONSECUTIVE_NIGHTS')).toHaveLength(0);
  });

  it('4연속은 위반이다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({
        shifts: [
          shift('2026-08-03', 'N'),
          shift('2026-08-04', 'N'),
          shift('2026-08-05', 'N'),
          shift('2026-08-06', 'N'),
        ],
      }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'MAX_CONSECUTIVE_NIGHTS');
    expect(v).toBeDefined();
    expect(v!.detail['consecutiveNights']).toBe(4);
  });

  it('오프가 끼면 연속이 끊긴다', () => {
    const result = evaluateRules(
      [KR_NURSING_SHIFT_2026],
      context(),
      data({
        shifts: [
          shift('2026-08-03', 'N'),
          shift('2026-08-04', 'N'),
          shift('2026-08-05', 'O'),
          shift('2026-08-06', 'N'),
          shift('2026-08-07', 'N'),
        ],
      }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'MAX_CONSECUTIVE_NIGHTS')).toHaveLength(0);
  });
});

describe('MAX_CONSECUTIVE_WORK_DAYS / WEEKLY_HOLIDAY_MIN / BREAK_TIME_MIN', () => {
  it('7일 연속 근무는 위반이다', () => {
    const dates = [
      '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
      '2026-08-07', '2026-08-08', '2026-08-09',
    ];
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ shifts: dates.map((d) => shift(d, 'D')) }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'MAX_CONSECUTIVE_WORK_DAYS');
    expect(v!.detail['consecutiveDays']).toBe(7);
  });

  it('주휴일이 없으면 경고한다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ weeklies: [{ memberId: 'm1', weekStart: '2026-08-03', totalMinutes: 2880, offDays: 0 }] }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'WEEKLY_HOLIDAY_MIN');
    expect(v!.severity).toBe('WARN');
    expect(v!.legalBasis).toBe('근로기준법 제55조 제1항');
  });

  it('8시간 근무에 휴게 30분은 부족하다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({
        dailies: [
          { memberId: 'm1', workDate: '2026-08-03', paidMinutes: 480, breakMinutes: 30 },
        ],
      }),
    );
    const v = result.violations.find((x) => x.ruleCode === 'BREAK_TIME_MIN');
    expect(v).toBeDefined();
    expect(v!.detail['requiredMinutes']).toBe(60);
  });

  it('4시간 미만 근무는 휴게 의무가 없다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({
        dailies: [
          { memberId: 'm1', workDate: '2026-08-03', paidMinutes: 200, breakMinutes: 0 },
        ],
      }),
    );
    expect(result.violations.filter((v) => v.ruleCode === 'BREAK_TIME_MIN')).toHaveLength(0);
  });
});

describe('위반 처리', () => {
  it('BLOCK 위반이 있으면 확정을 막을 대상으로 판정한다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ weeklies: [{ memberId: 'm1', weekStart: '2026-08-03', totalMinutes: 3300, offDays: 1 }] }),
    );
    expect(hasBlockingViolations(result.violations)).toBe(true);
    expect(summarizeViolations(result.violations).BLOCK).toBeGreaterThan(0);
  });

  it('BLOCK이 먼저 정렬된다', () => {
    const result = evaluateRules(
      DEFAULT_RULE_SETS,
      context(),
      data({
        weeklies: [{ memberId: 'm1', weekStart: '2026-08-03', totalMinutes: 3300, offDays: 0 }],
      }),
    );
    expect(result.violations[0]!.severity).toBe('BLOCK');
  });

  it('다른 구성원의 데이터는 평가하지 않는다', () => {
    const result = evaluateRules(
      [KR_GENERAL_2026],
      context(),
      data({ weeklies: [{ memberId: 'm2', weekStart: '2026-08-03', totalMinutes: 3300, offDays: 1 }] }),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('전공의 템플릿은 값이 확정되지 않아 적용되지 않는다', () => {
    const resolved = resolveRules(
      [KR_HEALTHCARE_EXCEPTION_2026],
      context({
        member: {
          id: 'm3',
          name: '이전공',
          worksiteId: 'w1',
          jobFamily: 'RESIDENT',
          employmentType: 'REGULAR',
        },
      }),
    );
    expect(resolved.has('WEEKLY_MAX_MINUTES')).toBe(false);
  });
});
