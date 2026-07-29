import { describe, expect, it } from 'vitest';
import {
  aggregateWeekly,
  computeDailyWorktime,
  fourWeekAverageMinutes,
  localDateTime,
  requiredBreakMinutes,
  type DailyWorktime,
} from '../src/index.js';

const iv = (date: string, start: string, endDate: string, end: string) => ({
  start: localDateTime(date, start),
  end: localDateTime(endDate, end),
});

describe('일별 근로시간 산정', () => {
  it('데이 근무 8시간 + 휴게 1시간 = 소정 7시간', () => {
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: iv('2026-07-29', '07:00', '2026-07-29', '15:00'),
      breakMinutes: 60,
      isHoliday: false,
    });
    expect(result.paidMinutes).toBe(420);
    expect(result.workMinutes).toBe(420);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.nightMinutes).toBe(0);
  });

  it('10시간 근무는 소정 8시간 + 연장 2시간', () => {
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: iv('2026-07-29', '08:00', '2026-07-29', '19:00'),
      breakMinutes: 60,
      isHoliday: false,
    });
    expect(result.paidMinutes).toBe(600);
    expect(result.workMinutes).toBe(480);
    expect(result.overtimeMinutes).toBe(120);
  });

  it('나이트 근무는 야간 8시간이 소정·연장과 중복 집계된다', () => {
    // 22:00~08:00 = 10시간, 휴게 1시간 → 유급 9시간
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: iv('2026-07-29', '22:00', '2026-07-30', '08:00'),
      breakMinutes: 60,
      isHoliday: false,
    });
    expect(result.paidMinutes).toBe(540);
    expect(result.workMinutes).toBe(480);
    expect(result.overtimeMinutes).toBe(60);
    // 연장 50% + 야간 50%가 각각 가산되므로 중복 집계가 맞다
    expect(result.nightMinutes).toBe(480);
  });

  it('휴일근로는 8시간 기준으로만 나뉜다', () => {
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-08-02',
      interval: iv('2026-08-02', '08:00', '2026-08-02', '19:00'),
      breakMinutes: 60,
      isHoliday: true,
    });
    expect(result.workMinutes).toBe(0);
    expect(result.overtimeMinutes).toBe(0);
    expect(result.holidayMinutes).toBe(480);
    expect(result.holidayOvertimeMinutes).toBe(120); // 가산율이 100%로 달라짐
  });

  it('미근무(오프)는 전부 0이다', () => {
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: null,
      breakMinutes: 0,
      isHoliday: false,
    });
    expect(result.paidMinutes).toBe(0);
    expect(result.workMinutes).toBe(0);
  });

  it('휴게가 근무시간보다 길면 근무시간까지만 차감한다', () => {
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: iv('2026-07-29', '09:00', '2026-07-29', '09:30'),
      breakMinutes: 60,
      isHoliday: false,
    });
    expect(result.paidMinutes).toBe(0);
    expect(result.breakMinutes).toBe(30);
  });

  describe('당직·온콜 산정', () => {
    it('FULL_WORK는 전 시간을 근로시간으로 본다', () => {
      const result = computeDailyWorktime({
        memberId: 'm1',
        workDate: '2026-07-29',
        interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
        breakMinutes: 0,
        isHoliday: false,
        dutyMode: 'FULL_WORK',
      });
      expect(result.paidMinutes).toBe(900);
    });

    it('CALL_ONLY는 호출 응대 구간만 근로시간으로 본다', () => {
      const result = computeDailyWorktime({
        memberId: 'm1',
        workDate: '2026-07-29',
        interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
        breakMinutes: 0,
        isHoliday: false,
        dutyMode: 'CALL_ONLY',
        callIntervals: [
          iv('2026-07-29', '23:00', '2026-07-30', '00:30'),
          iv('2026-07-30', '04:00', '2026-07-30', '05:00'),
        ],
      });
      expect(result.paidMinutes).toBe(150); // 90분 + 60분
      // 두 호출 모두 야간 시간대
      expect(result.nightMinutes).toBe(150);
    });

    it('CALL_ONLY인데 호출이 없으면 근로시간이 0이다', () => {
      const result = computeDailyWorktime({
        memberId: 'm1',
        workDate: '2026-07-29',
        interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
        breakMinutes: 0,
        isHoliday: false,
        dutyMode: 'CALL_ONLY',
        callIntervals: [],
      });
      expect(result.paidMinutes).toBe(0);
    });

    it('POLICY_RATIO는 계수를 곱한다', () => {
      const result = computeDailyWorktime({
        memberId: 'm1',
        workDate: '2026-07-29',
        interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
        breakMinutes: 0,
        isHoliday: false,
        dutyMode: 'POLICY_RATIO',
        dutyRatio: 0.5,
      });
      expect(result.paidMinutes).toBe(450);
    });

    it('POLICY_RATIO인데 계수가 없으면 오류다', () => {
      expect(() =>
        computeDailyWorktime({
          memberId: 'm1',
          workDate: '2026-07-29',
          interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
          breakMinutes: 0,
          isHoliday: false,
          dutyMode: 'POLICY_RATIO',
          dutyRatio: null,
        }),
      ).toThrow(/dutyRatio/);
    });
  });

  it('유급시간 override는 계산식을 대체한다', () => {
    // "당직은 실제 15시간이어도 4시간만 유급"처럼 노사합의로 정해진 경우
    const result = computeDailyWorktime({
      memberId: 'm1',
      workDate: '2026-07-29',
      interval: iv('2026-07-29', '18:00', '2026-07-30', '09:00'),
      breakMinutes: 0,
      isHoliday: false,
      paidMinutesOverride: 240,
    });
    expect(result.paidMinutes).toBe(240);
  });
});

describe('법정 휴게시간', () => {
  it('4시간 미만은 휴게 의무가 없다', () => {
    expect(requiredBreakMinutes(239)).toBe(0);
  });
  it('4시간 이상 8시간 미만은 30분', () => {
    expect(requiredBreakMinutes(240)).toBe(30);
    expect(requiredBreakMinutes(479)).toBe(30);
  });
  it('8시간 이상은 60분', () => {
    expect(requiredBreakMinutes(480)).toBe(60);
  });
});

describe('주별 집계', () => {
  const daily = (
    workDate: string,
    over: Partial<DailyWorktime> = {},
  ): DailyWorktime => ({
    memberId: 'm1',
    workDate,
    paidMinutes: 480,
    workMinutes: 480,
    overtimeMinutes: 0,
    nightMinutes: 0,
    holidayMinutes: 0,
    holidayOvertimeMinutes: 0,
    breakMinutes: 60,
    ...over,
  });

  it('월요일 기준으로 주를 묶는다', () => {
    // 2026-07-27(월) ~ 2026-08-02(일)
    const weeks = aggregateWeekly([daily('2026-07-27'), daily('2026-08-02')]);
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.weekStart).toBe('2026-07-27');
  });

  it('5일 × 8시간이면 연장이 없다', () => {
    const days = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
    const weeks = aggregateWeekly(days.map((d) => daily(d)));
    expect(weeks[0]!.scheduledMinutes).toBe(2400);
    expect(weeks[0]!.overtimeMinutes).toBe(0);
  });

  it('6일 × 8시간이면 주 단위 초과 8시간이 연장이 된다', () => {
    const days = [
      '2026-07-27', '2026-07-28', '2026-07-29',
      '2026-07-30', '2026-07-31', '2026-08-01',
    ];
    const weeks = aggregateWeekly(days.map((d) => daily(d)));
    expect(weeks[0]!.scheduledMinutes).toBe(2880);
    expect(weeks[0]!.overtimeMinutes).toBe(480);
  });

  it('5일 × 10시간이면 일 단위 연장 합계 10시간이 적용된다', () => {
    const days = ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'];
    const weeks = aggregateWeekly(
      days.map((d) => daily(d, { paidMinutes: 600, workMinutes: 480, overtimeMinutes: 120 })),
    );
    expect(weeks[0]!.overtimeMinutes).toBe(600);
  });

  it('일·주 기준을 이중 계산하지 않고 큰 쪽을 취한다', () => {
    // 6일 × 10시간: 일 단위 연장 12시간, 주 단위 초과 8시간 → 12시간
    const days = [
      '2026-07-27', '2026-07-28', '2026-07-29',
      '2026-07-30', '2026-07-31', '2026-08-01',
    ];
    const weeks = aggregateWeekly(
      days.map((d) => daily(d, { paidMinutes: 600, workMinutes: 480, overtimeMinutes: 120 })),
    );
    expect(weeks[0]!.overtimeMinutes).toBe(720);
    expect(weeks[0]!.totalMinutes).toBe(3600); // 60시간 — 52시간 초과
  });

  it('휴무일 수를 센다', () => {
    const weeks = aggregateWeekly([
      daily('2026-07-27'),
      daily('2026-07-28', { paidMinutes: 0, workMinutes: 0 }),
    ]);
    expect(weeks[0]!.workedDays).toBe(1);
    expect(weeks[0]!.offDays).toBe(1);
  });

  it('구성원별로 분리 집계한다', () => {
    const weeks = aggregateWeekly([
      daily('2026-07-27'),
      { ...daily('2026-07-27'), memberId: 'm2' },
    ]);
    expect(weeks).toHaveLength(2);
  });

  it('4주 평균은 4주치가 있어야 산정된다', () => {
    const weeks = aggregateWeekly(
      ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'].flatMap((weekStart) =>
        [0, 1, 2, 3, 4].map((offset) => {
          const d = new Date(Date.parse(`${weekStart}T00:00:00Z`) + offset * 86_400_000);
          return daily(d.toISOString().slice(0, 10));
        }),
      ),
    );
    expect(fourWeekAverageMinutes(weeks, '2026-07-27')).toBe(2400);
    expect(fourWeekAverageMinutes(weeks, '2026-07-13')).toBeNull();
  });
});
