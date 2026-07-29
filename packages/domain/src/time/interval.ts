/**
 * 시간 구간 계산.
 *
 * 설계 전제 — 고정 오프셋 시간대만 지원한다.
 * 한국(Asia/Seoul, UTC+9)은 서머타임이 없으므로 고정 오프셋으로 정확히 계산된다.
 * 서머타임이 있는 지역을 지원해야 하면 이 모듈 전체를 IANA 시간대 기반으로
 * 교체해야 한다. 지금 Date의 로컬 시간대에 의존하지 않는 이유가 이것이다 —
 * 서버 TZ 설정에 따라 근로시간 계산이 달라지는 사고를 막는다.
 */

/** 한국 표준시 오프셋(분). */
export const KST_OFFSET_MINUTES = 540;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** 반열린 구간 `[start, end)`. */
export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

/** `YYYY-MM-DD` 형식의 로컬 날짜. */
export type LocalDate = string;

/** `HH:mm` 형식의 로컬 시각. */
export type LocalTime = string;

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidLocalTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const h = Number(match[1]);
  const min = Number(match[2]);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** `HH:mm`을 자정 기준 분으로 변환한다. */
export function timeToMinutes(time: LocalTime): number {
  if (!isValidLocalTime(time)) {
    throw new RangeError(`잘못된 시각 형식입니다: ${time} (HH:mm 이어야 합니다)`);
  }
  const [h, m] = time.split(':').map(Number) as [number, number];
  return h * 60 + m;
}

/** 로컬 날짜·시각을 UTC 인스턴트로 변환한다. */
export function localDateTime(
  date: LocalDate,
  time: LocalTime,
  offsetMinutes: number = KST_OFFSET_MINUTES,
): Date {
  if (!isValidLocalDate(date)) {
    throw new RangeError(`잘못된 날짜 형식입니다: ${date} (YYYY-MM-DD 이어야 합니다)`);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + timeToMinutes(time) * MS_PER_MINUTE - offsetMinutes * MS_PER_MINUTE);
}

/** 인스턴트가 속한 로컬 날짜를 돌려준다. */
export function toLocalDate(instant: Date, offsetMinutes: number = KST_OFFSET_MINUTES): LocalDate {
  const shifted = new Date(instant.getTime() + offsetMinutes * MS_PER_MINUTE);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 로컬 날짜에 일수를 더한다. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * MS_PER_DAY);
  return toLocalDate(shifted, 0);
}

/** 두 로컬 날짜 사이의 일수(b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const ta = localDateTime(a, '00:00', 0).getTime();
  const tb = localDateTime(b, '00:00', 0).getTime();
  return Math.round((tb - ta) / MS_PER_DAY);
}

/** 요일. 0=일요일 … 6=토요일. */
export function dayOfWeek(date: LocalDate): number {
  return localDateTime(date, '00:00', 0).getUTCDay();
}

/** 해당 날짜가 속한 주의 월요일. */
export function startOfWeek(date: LocalDate): LocalDate {
  const dow = dayOfWeek(date);
  const delta = dow === 0 ? -6 : 1 - dow;
  return addDays(date, delta);
}

export function intervalMinutes(interval: Interval): number {
  return Math.max(0, (interval.end.getTime() - interval.start.getTime()) / MS_PER_MINUTE);
}

export function overlapMinutes(a: Interval, b: Interval): number {
  const start = Math.max(a.start.getTime(), b.start.getTime());
  const end = Math.min(a.end.getTime(), b.end.getTime());
  return Math.max(0, (end - start) / MS_PER_MINUTE);
}

/** 두 구간이 겹치는가. 경계가 맞닿는 것(`a.end === b.start`)은 겹침이 아니다. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** 앞 구간 종료부터 뒤 구간 시작까지의 간격(분). 겹치면 음수. */
export function gapMinutes(earlier: Interval, later: Interval): number {
  return (later.start.getTime() - earlier.end.getTime()) / MS_PER_MINUTE;
}

export interface NightWindow {
  /** 야간 시작 시각(시). 기본 22시. */
  readonly startHour: number;
  /** 야간 종료 시각(시). 기본 6시(익일). */
  readonly endHour: number;
}

export const DEFAULT_NIGHT_WINDOW: NightWindow = { startHour: 22, endHour: 6 };

/**
 * 야간근로시간(분)을 계산한다. 근기법 제56조 제3항의 22:00~06:00 시간대.
 *
 * 자정을 넘기는 나이트 근무(예: 22:00~08:00)를 정확히 처리하기 위해
 * 구간이 걸치는 모든 로컬 날짜의 야간 윈도우와 겹침을 합산한다.
 */
export function nightMinutes(
  interval: Interval,
  window: NightWindow = DEFAULT_NIGHT_WINDOW,
  offsetMinutes: number = KST_OFFSET_MINUTES,
): number {
  if (intervalMinutes(interval) === 0) return 0;

  const toLocalDayIndex = (instant: Date): number =>
    Math.floor((instant.getTime() + offsetMinutes * MS_PER_MINUTE) / MS_PER_DAY);

  // 전날 22시 시작 윈도우가 당일 새벽까지 이어지므로 하루 앞에서부터 훑는다.
  const firstDay = toLocalDayIndex(interval.start) - 1;
  const lastDay = toLocalDayIndex(new Date(interval.end.getTime() - 1));

  let total = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const localMidnightUtc = day * MS_PER_DAY - offsetMinutes * MS_PER_MINUTE;
    const windowStart = localMidnightUtc + window.startHour * MS_PER_HOUR;
    const windowEnd = localMidnightUtc + (24 + window.endHour) * MS_PER_HOUR;
    total += overlapMinutes(interval, {
      start: new Date(windowStart),
      end: new Date(windowEnd),
    });
  }
  return total;
}

/** 구간이 로컬 자정을 넘기는가. */
export function crossesMidnight(
  interval: Interval,
  offsetMinutes: number = KST_OFFSET_MINUTES,
): boolean {
  return toLocalDate(interval.start, offsetMinutes) !== toLocalDate(
    new Date(interval.end.getTime() - 1),
    offsetMinutes,
  );
}
