/** 근무유형(ShiftType)과 근무 배정으로부터 실제 시간 구간을 확정한다. */

import {
  KST_OFFSET_MINUTES,
  type Interval,
  type LocalDate,
  type LocalTime,
  addDays,
  localDateTime,
  timeToMinutes,
} from './interval.js';

/** 근무유형의 성격. 근로시간 산정 방식을 좌우한다. */
export type ShiftCategory = 'WORK' | 'OFF' | 'LEAVE' | 'DUTY' | 'ONCALL';

/**
 * 당직·온콜의 근로시간 산정 방식.
 *
 * ⚖️ 대기시간의 근로시간성은 다툼이 많은 영역이다. 제품은 기관이 자신의 정책을
 * 설정하게 하고 그 정책과 근거를 기록으로 남기는 것까지가 역할이며,
 * 법적 판단을 대신하지 않는다. (docs/02-domain-rules.md §4.3)
 */
export type DutyMode =
  /** 전 시간을 근로시간으로 본다. 원내 당직에서 일반적. */
  | 'FULL_WORK'
  /** 호출 기록(CallEvent)의 합만 근로시간으로 본다. 자택 대기 온콜에서 일반적. */
  | 'CALL_ONLY'
  /** 전체 시간 × 계수. 노사합의로 정한 경우. */
  | 'POLICY_RATIO';

export interface ShiftType {
  readonly code: string;
  readonly name: string;
  readonly category: ShiftCategory;
  /** `HH:mm`. category가 OFF/LEAVE면 null. */
  readonly startTime: LocalTime | null;
  readonly endTime: LocalTime | null;
  readonly breakMinutes: number;
  /**
   * 계산식으로 표현할 수 없는 유급시간을 값으로 못박을 때 사용한다.
   * null이면 `종료 - 시작 - 휴게`로 계산한다.
   */
  readonly paidMinutesOverride: number | null;
  readonly countsAsWork: boolean;
  readonly dutyMode: DutyMode | null;
  readonly dutyRatio: number | null;
  readonly isNight: boolean;
}

export interface ShiftAssignment {
  readonly id: string;
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly shiftType: ShiftType;
  /** 개별 조정. 근무유형 기본 시각과 다르게 배정할 때. */
  readonly startOverride?: LocalTime;
  readonly endOverride?: LocalTime;
}

/** 근무유형이 자정을 넘기는가. 종료가 시작보다 이르면 익일로 해석한다. */
export function shiftCrossesMidnight(start: LocalTime, end: LocalTime): boolean {
  return timeToMinutes(end) <= timeToMinutes(start);
}

/**
 * 근무 배정의 실제 시간 구간을 계산한다.
 *
 * 종료 시각이 시작 시각보다 이르거나 같으면 익일로 해석한다.
 * 나이트 근무(22:00~08:00)가 이 경로를 탄다.
 */
export function resolveShiftInterval(
  assignment: ShiftAssignment,
  offsetMinutes: number = KST_OFFSET_MINUTES,
): Interval | null {
  const start = assignment.startOverride ?? assignment.shiftType.startTime;
  const end = assignment.endOverride ?? assignment.shiftType.endTime;
  if (start === null || end === null) return null;

  const endDate = shiftCrossesMidnight(start, end)
    ? addDays(assignment.workDate, 1)
    : assignment.workDate;

  return {
    start: localDateTime(assignment.workDate, start, offsetMinutes),
    end: localDateTime(endDate, end, offsetMinutes),
  };
}

/** 실제 근무가 발생하는 배정인가. 오프·휴가는 제외. */
export function isWorkingAssignment(assignment: ShiftAssignment): boolean {
  const { category, countsAsWork } = assignment.shiftType;
  return countsAsWork && category !== 'OFF' && category !== 'LEAVE';
}
