/** 주별 근로시간 집계. 주 52시간 및 특례 판정의 입력이 된다. */

import { type LocalDate, startOfWeek } from '../time/interval.js';
import type { DailyWorktime } from './daily.js';

/** 1주 소정근로시간 기본값. 근기법 제50조 제1항. */
export const DEFAULT_WEEKLY_STD_MINUTES = 2400; // 40시간

/** 1주 연장근로 한도 기본값. 근기법 제53조 제1항. */
export const DEFAULT_WEEKLY_OT_LIMIT_MINUTES = 720; // 12시간

export interface WeeklyWorktime {
  readonly memberId: string;
  /** 해당 주의 월요일. */
  readonly weekStart: LocalDate;
  /** 소정근로 합계(주 상한으로 캡되지 않은 원값). */
  readonly scheduledMinutes: number;
  /**
   * 연장근로. 일 단위 초과분 합계와 주 단위 초과분 중 큰 값.
   * 일·주 기준을 모두 적용하되 이중 계산하지 않는 실무 방식이다.
   */
  readonly overtimeMinutes: number;
  readonly nightMinutes: number;
  readonly holidayMinutes: number;
  readonly holidayOvertimeMinutes: number;
  /**
   * 주간 유급시간 총계. 주 52시간 판정은 이 값으로 한다.
   * 2018년 개정으로 휴일근로가 연장근로에 포함되므로 휴일근로도 합산한다.
   * ⚖️ 검토필요: 사업장 규모·특례 여부에 따라 판정 기준이 달라질 수 있다.
   */
  readonly totalMinutes: number;
  /** 근무일 수(유급시간 > 0인 날). */
  readonly workedDays: number;
  /** 휴무일 수(유급시간 == 0인 날). */
  readonly offDays: number;
  readonly dailyCount: number;
}

export interface WeeklyAggregateOptions {
  readonly weeklyStdMinutes?: number;
}

/** 일별 집계를 주 단위로 묶는다. 여러 주에 걸친 입력도 처리한다. */
export function aggregateWeekly(
  dailies: readonly DailyWorktime[],
  options: WeeklyAggregateOptions = {},
): WeeklyWorktime[] {
  const { weeklyStdMinutes = DEFAULT_WEEKLY_STD_MINUTES } = options;

  const buckets = new Map<string, DailyWorktime[]>();
  for (const daily of dailies) {
    const key = `${daily.memberId}|${startOfWeek(daily.workDate)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(daily);
    else buckets.set(key, [daily]);
  }

  const results: WeeklyWorktime[] = [];
  for (const [key, group] of buckets) {
    const [memberId, weekStart] = key.split('|') as [string, LocalDate];

    const scheduledMinutes = sum(group, (d) => d.workMinutes);
    const dailyOvertimeSum = sum(group, (d) => d.overtimeMinutes);
    const holidayMinutes = sum(group, (d) => d.holidayMinutes);
    const holidayOvertimeMinutes = sum(group, (d) => d.holidayOvertimeMinutes);

    // 주 단위 초과분: 소정근로 합계가 주 상한을 넘은 부분.
    const weeklyExcess = Math.max(0, scheduledMinutes - weeklyStdMinutes);
    const overtimeMinutes = Math.max(dailyOvertimeSum, weeklyExcess);

    results.push({
      memberId,
      weekStart,
      scheduledMinutes,
      overtimeMinutes,
      nightMinutes: sum(group, (d) => d.nightMinutes),
      holidayMinutes,
      holidayOvertimeMinutes,
      totalMinutes: sum(group, (d) => d.paidMinutes),
      workedDays: group.filter((d) => d.paidMinutes > 0).length,
      offDays: group.filter((d) => d.paidMinutes === 0).length,
      dailyCount: group.length,
    });
  }

  return results.sort((a, b) =>
    a.memberId === b.memberId
      ? a.weekStart.localeCompare(b.weekStart)
      : a.memberId.localeCompare(b.memberId),
  );
}

/**
 * 4주 평균 주간 근로시간(분). 전공의 수련시간 산정에 쓴다.
 * 전공의법은 4주 평균으로 상한을 판정하므로 주 단위 값만으로는 부족하다.
 */
export function fourWeekAverageMinutes(
  weeklies: readonly WeeklyWorktime[],
  endWeekStart: LocalDate,
): number | null {
  const sorted = [...weeklies].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
  const endIndex = sorted.findIndex((w) => w.weekStart === endWeekStart);
  if (endIndex < 3) return null; // 4주치가 없으면 산정 불가
  const window = sorted.slice(endIndex - 3, endIndex + 1);
  return sum(window, (w) => w.totalMinutes) / window.length;
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((acc, item) => acc + pick(item), 0);
}
