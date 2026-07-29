/**
 * 일별 근로시간 산정.
 *
 * 이 모듈의 버그는 급여 오지급으로 직결된다. 순수 함수로 유지하고
 * 테스트를 가장 두껍게 쌓는다. (docs/03-architecture.md §8.3)
 */

import {
  DEFAULT_NIGHT_WINDOW,
  KST_OFFSET_MINUTES,
  type Interval,
  type LocalDate,
  type NightWindow,
  intervalMinutes,
  nightMinutes,
} from '../time/interval.js';
import type { DutyMode } from '../time/shift.js';

/** 1일 소정근로시간 기본값. 근기법 제50조 제2항. */
export const DEFAULT_DAILY_STD_MINUTES = 480;

export interface DailyWorktimeInput {
  readonly memberId: string;
  readonly workDate: LocalDate;
  /** 근무 구간. null이면 미근무(오프·휴가·결근). */
  readonly interval: Interval | null;
  readonly breakMinutes: number;
  /**
   * 주휴일 또는 약정 휴일 여부. 휴일근로 가산(근기법 제56조 제2항) 판정에 쓴다.
   */
  readonly isHoliday: boolean;
  readonly dailyStdMinutes?: number;
  readonly dutyMode?: DutyMode | null;
  readonly dutyRatio?: number | null;
  /** dutyMode가 CALL_ONLY일 때 실제 호출 응대 구간. */
  readonly callIntervals?: readonly Interval[];
  /** 계산식 대신 값으로 못박은 유급시간. */
  readonly paidMinutesOverride?: number | null;
  readonly nightWindow?: NightWindow;
  readonly offsetMinutes?: number;
}

export interface DailyWorktime {
  readonly memberId: string;
  readonly workDate: LocalDate;
  /** 휴게를 제외한 유급 대상 시간. */
  readonly paidMinutes: number;
  /** 소정근로. 1일 상한(기본 8시간)까지. */
  readonly workMinutes: number;
  /** 연장근로. 1일 상한 초과분. */
  readonly overtimeMinutes: number;
  /** 야간근로(22:00~06:00). 소정·연장과 중복 집계된다(가산이 중복 적용되므로). */
  readonly nightMinutes: number;
  /** 휴일근로 8시간 이내분. */
  readonly holidayMinutes: number;
  /** 휴일근로 8시간 초과분. 가산율이 다르므로 분리한다. */
  readonly holidayOvertimeMinutes: number;
  readonly breakMinutes: number;
}

/**
 * 일별 근로시간을 산정한다.
 *
 * 산정 규칙
 * - 유급시간 = 근무시간 - 휴게시간 (당직 모드에 따라 근무시간이 먼저 조정됨)
 * - 평일: 소정 = min(유급, 1일 상한), 연장 = 나머지
 * - 휴일: 전부 휴일근로로 분류하고 8시간 기준으로만 나눈다
 * - 야간: 22:00~06:00 겹침. 소정/연장/휴일과 **중복 집계**된다.
 *   근기법 제56조상 연장 50% + 야간 50%가 각각 가산되기 때문이다.
 *
 * 알려진 단순화
 * - 휴게시간이 야간 시간대에 걸친 경우를 반영하지 않는다. 휴게 시각을 실제로
 *   기록하는 기관에서는 `callIntervals`처럼 휴게 구간을 받아 차감해야 한다.
 *   docs/02-domain-rules.md §8의 미해결 논점 참고.
 */
export function computeDailyWorktime(input: DailyWorktimeInput): DailyWorktime {
  const {
    memberId,
    workDate,
    interval,
    breakMinutes,
    isHoliday,
    dailyStdMinutes = DEFAULT_DAILY_STD_MINUTES,
    dutyMode = null,
    dutyRatio = null,
    callIntervals = [],
    paidMinutesOverride = null,
    nightWindow = DEFAULT_NIGHT_WINDOW,
    offsetMinutes = KST_OFFSET_MINUTES,
  } = input;

  const empty: DailyWorktime = {
    memberId,
    workDate,
    paidMinutes: 0,
    workMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    holidayMinutes: 0,
    holidayOvertimeMinutes: 0,
    breakMinutes: 0,
  };

  if (interval === null) return empty;

  // 근로시간으로 셈할 구간을 당직 모드에 따라 결정한다.
  const countedIntervals: readonly Interval[] =
    dutyMode === 'CALL_ONLY' ? callIntervals : [interval];

  let rawMinutes = countedIntervals.reduce((sum, i) => sum + intervalMinutes(i), 0);

  if (dutyMode === 'POLICY_RATIO') {
    if (dutyRatio === null) {
      throw new Error(
        `dutyMode가 POLICY_RATIO이면 dutyRatio가 필요합니다 (memberId=${memberId}, workDate=${workDate})`,
      );
    }
    rawMinutes = Math.round(rawMinutes * dutyRatio);
  }

  const appliedBreak = Math.min(breakMinutes, rawMinutes);
  const paidMinutes =
    paidMinutesOverride !== null ? paidMinutesOverride : Math.max(0, rawMinutes - appliedBreak);

  if (paidMinutes === 0) return { ...empty, breakMinutes: appliedBreak };

  const night = countedIntervals.reduce(
    (sum, i) => sum + nightMinutes(i, nightWindow, offsetMinutes),
    0,
  );

  if (isHoliday) {
    const holidayMinutes = Math.min(paidMinutes, dailyStdMinutes);
    return {
      memberId,
      workDate,
      paidMinutes,
      workMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: night,
      holidayMinutes,
      holidayOvertimeMinutes: paidMinutes - holidayMinutes,
      breakMinutes: appliedBreak,
    };
  }

  const workMinutes = Math.min(paidMinutes, dailyStdMinutes);
  return {
    memberId,
    workDate,
    paidMinutes,
    workMinutes,
    overtimeMinutes: paidMinutes - workMinutes,
    nightMinutes: night,
    holidayMinutes: 0,
    holidayOvertimeMinutes: 0,
    breakMinutes: appliedBreak,
  };
}

/**
 * 법정 휴게시간 요건을 만족하는지 검사한다. 근기법 제54조.
 * 4시간 근무 시 30분 이상, 8시간 근무 시 1시간 이상.
 */
export function requiredBreakMinutes(workedMinutes: number): number {
  if (workedMinutes >= 480) return 60;
  if (workedMinutes >= 240) return 30;
  return 0;
}
