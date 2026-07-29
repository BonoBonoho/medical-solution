import { describe, expect, it } from 'vitest';
import {
  KST_OFFSET_MINUTES,
  addDays,
  crossesMidnight,
  dayOfWeek,
  daysBetween,
  gapMinutes,
  intervalMinutes,
  localDateTime,
  nightMinutes,
  overlapMinutes,
  resolveShiftInterval,
  shiftCrossesMidnight,
  startOfWeek,
  toLocalDate,
  type ShiftType,
} from '../src/index.js';

const shift = (over: Partial<ShiftType> = {}): ShiftType => ({
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
  ...over,
});

describe('로컬 날짜/시각 변환', () => {
  it('KST 로컬 시각을 UTC 인스턴트로 변환한다', () => {
    // 2026-07-29 09:00 KST === 2026-07-29 00:00 UTC
    expect(localDateTime('2026-07-29', '09:00').toISOString()).toBe('2026-07-29T00:00:00.000Z');
  });

  it('서버 TZ와 무관하게 동작한다 (오프셋을 명시적으로 받는다)', () => {
    expect(localDateTime('2026-07-29', '00:00', 0).toISOString()).toBe(
      '2026-07-29T00:00:00.000Z',
    );
  });

  it('UTC 인스턴트로부터 로컬 날짜를 되돌린다', () => {
    // 2026-07-28 23:00 UTC === 2026-07-29 08:00 KST
    expect(toLocalDate(new Date('2026-07-28T23:00:00Z'))).toBe('2026-07-29');
  });

  it('잘못된 형식을 거부한다', () => {
    expect(() => localDateTime('2026-7-29', '09:00')).toThrow(RangeError);
    expect(() => localDateTime('2026-02-30', '09:00')).toThrow(RangeError);
    expect(() => localDateTime('2026-07-29', '25:00')).toThrow(RangeError);
  });

  it('윤년을 처리한다', () => {
    expect(() => localDateTime('2028-02-29', '09:00')).not.toThrow();
    expect(() => localDateTime('2026-02-29', '09:00')).toThrow(RangeError);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('날짜 연산이 월·연 경계를 넘는다', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
  });

  it('주의 시작은 월요일이다', () => {
    expect(dayOfWeek('2026-07-29')).toBe(3); // 수요일
    expect(startOfWeek('2026-07-29')).toBe('2026-07-27'); // 월요일
    expect(startOfWeek('2026-07-27')).toBe('2026-07-27');
    expect(startOfWeek('2026-08-02')).toBe('2026-07-27'); // 일요일은 그 주에 속함
  });
});

describe('구간 계산', () => {
  it('겹침을 분 단위로 계산한다', () => {
    const a = { start: new Date('2026-07-29T00:00:00Z'), end: new Date('2026-07-29T08:00:00Z') };
    const b = { start: new Date('2026-07-29T06:00:00Z'), end: new Date('2026-07-29T12:00:00Z') };
    expect(overlapMinutes(a, b)).toBe(120);
  });

  it('맞닿기만 하면 겹침이 아니다', () => {
    const a = { start: new Date('2026-07-29T00:00:00Z'), end: new Date('2026-07-29T08:00:00Z') };
    const b = { start: new Date('2026-07-29T08:00:00Z'), end: new Date('2026-07-29T12:00:00Z') };
    expect(overlapMinutes(a, b)).toBe(0);
    expect(gapMinutes(a, b)).toBe(0);
  });

  it('겹치는 구간의 간격은 음수다', () => {
    const a = { start: new Date('2026-07-29T00:00:00Z'), end: new Date('2026-07-29T08:00:00Z') };
    const b = { start: new Date('2026-07-29T07:00:00Z'), end: new Date('2026-07-29T12:00:00Z') };
    expect(gapMinutes(a, b)).toBe(-60);
  });
});

describe('야간근로시간 (22:00~06:00)', () => {
  const interval = (date: string, start: string, endDate: string, end: string) => ({
    start: localDateTime(date, start),
    end: localDateTime(endDate, end),
  });

  it('데이 근무(07:00~15:00)는 야간이 0이다', () => {
    expect(nightMinutes(interval('2026-07-29', '07:00', '2026-07-29', '15:00'))).toBe(0);
  });

  it('이브닝 근무(15:00~23:00)는 22:00~23:00의 1시간이 야간이다', () => {
    expect(nightMinutes(interval('2026-07-29', '15:00', '2026-07-29', '23:00'))).toBe(60);
  });

  it('나이트 근무(22:00~08:00)는 22:00~06:00의 8시간이 야간이다', () => {
    expect(nightMinutes(interval('2026-07-29', '22:00', '2026-07-30', '08:00'))).toBe(480);
  });

  it('자정 직후 시작(00:00~06:00)도 전부 야간이다', () => {
    expect(nightMinutes(interval('2026-07-29', '00:00', '2026-07-29', '06:00'))).toBe(360);
  });

  it('24시간 연속 근무는 야간 8시간이다', () => {
    expect(nightMinutes(interval('2026-07-29', '09:00', '2026-07-30', '09:00'))).toBe(480);
  });

  it('48시간 연속 근무는 야간 16시간이다 (여러 날 윈도우 합산)', () => {
    expect(nightMinutes(interval('2026-07-29', '09:00', '2026-07-31', '09:00'))).toBe(960);
  });

  it('빈 구간은 0이다', () => {
    expect(nightMinutes(interval('2026-07-29', '09:00', '2026-07-29', '09:00'))).toBe(0);
  });
});

describe('근무유형 구간 확정', () => {
  it('자정을 넘기는 근무유형을 판정한다', () => {
    expect(shiftCrossesMidnight('22:00', '08:00')).toBe(true);
    expect(shiftCrossesMidnight('07:00', '15:00')).toBe(false);
    // 24시간 근무: 시작과 종료가 같으면 익일로 본다
    expect(shiftCrossesMidnight('09:00', '09:00')).toBe(true);
  });

  it('나이트 근무의 종료는 익일이다', () => {
    const resolved = resolveShiftInterval({
      id: 'a1',
      memberId: 'm1',
      workDate: '2026-07-29',
      shiftType: shift({ code: 'N', startTime: '22:00', endTime: '08:00', isNight: true }),
    });
    expect(resolved).not.toBeNull();
    expect(intervalMinutes(resolved!)).toBe(600);
    expect(toLocalDate(resolved!.end)).toBe('2026-07-30');
    expect(crossesMidnight(resolved!)).toBe(true);
  });

  it('개별 조정 시각이 근무유형 기본값을 덮어쓴다', () => {
    const resolved = resolveShiftInterval({
      id: 'a2',
      memberId: 'm1',
      workDate: '2026-07-29',
      shiftType: shift(),
      startOverride: '06:30',
    });
    expect(intervalMinutes(resolved!)).toBe(510); // 06:30~15:00
  });

  it('오프는 구간이 없다', () => {
    const resolved = resolveShiftInterval({
      id: 'a3',
      memberId: 'm1',
      workDate: '2026-07-29',
      shiftType: shift({ code: 'O', category: 'OFF', startTime: null, endTime: null }),
    });
    expect(resolved).toBeNull();
  });

  it('오프셋을 명시하면 그에 맞게 계산한다', () => {
    const resolved = resolveShiftInterval(
      {
        id: 'a4',
        memberId: 'm1',
        workDate: '2026-07-29',
        shiftType: shift(),
      },
      KST_OFFSET_MINUTES,
    );
    expect(resolved!.start.toISOString()).toBe('2026-07-28T22:00:00.000Z');
  });
});
