/**
 * 휴가 일수 단위.
 *
 * 부동소수점을 쓰지 않는다. 반차·반반차를 섞어 쓰면 0.25 단위 누적이 반복되고,
 * float를 쓰면 잔액이 8.499999999 가 되는 사고가 반드시 발생한다.
 * 내부적으로는 정수(1일 = 100)로 계산하고 경계에서만 변환한다.
 * (docs/07-leave-management.md §10.2)
 */

/** 1일에 해당하는 내부 단위. */
export const UNITS_PER_DAY = 100;

/** 휴가 일수의 내부 표현. 정수. 100 = 1일, 50 = 0.5일, 25 = 0.25일. */
export type LeaveUnits = number;

export function daysToUnits(days: number): LeaveUnits {
  const units = Math.round(days * UNITS_PER_DAY);
  if (!Number.isFinite(units)) {
    throw new RangeError(`휴가 일수로 변환할 수 없는 값입니다: ${days}`);
  }
  return units;
}

export function unitsToDays(units: LeaveUnits): number {
  return units / UNITS_PER_DAY;
}

/** 표시용 문자열. 소수점 이하 불필요한 0을 제거한다. */
export function formatUnits(units: LeaveUnits): string {
  const days = unitsToDays(units);
  return Number.isInteger(days) ? `${days}일` : `${days.toFixed(2).replace(/0+$/, '')}일`;
}

export const HALF_DAY_UNITS: LeaveUnits = 50;
export const QUARTER_DAY_UNITS: LeaveUnits = 25;
