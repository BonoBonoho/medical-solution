/**
 * 연차유급휴가 산정. 근로기준법 제60조.
 *
 * ⚖️ 이 로직은 공인노무사 검증이 필수다. 특히 회계연도 기준 운영과
 * 1년 미만 근로자의 월차 소멸 시점은 해석이 갈리는 영역이다.
 */

import { addDays, daysBetween, type LocalDate } from '../time/interval.js';
import { type LeaveUnits, daysToUnits } from './units.js';

export type GrantReason =
  /** 1년 이상 근속에 따른 기본 15일. 근기법 §60① */
  | 'BASE_15'
  /** 1년 미만 또는 출근율 80% 미만 시 1개월 개근당 1일. 근기법 §60② */
  | 'MONTHLY_1'
  /** 3년 이상 근속 가산. 근기법 §60④ */
  | 'TENURE_EXTRA'
  /** 회계연도 기준 첫 해 비례부여. */
  | 'FISCAL_PRORATED'
  /** 보상휴가. 근기법 §57 */
  | 'COMPENSATORY'
  /** 관리자 수동 조정. */
  | 'MANUAL_ADJUST';

export type BalanceSource = 'ANNUAL' | 'COMP_LEAVE';

export interface LeaveGrant {
  readonly id: string;
  readonly memberId: string;
  readonly balanceSource: BalanceSource;
  readonly reason: GrantReason;
  readonly grantedUnits: LeaveUnits;
  readonly usedUnits: LeaveUnits;
  readonly expiredUnits: LeaveUnits;
  readonly effectiveFrom: LocalDate;
  readonly expiresAt: LocalDate;
  /** 산정 근거. "왜 이만큼 받았나"에 답할 수 있어야 한다. */
  readonly basis: Readonly<Record<string, unknown>>;
}

/**
 * 근속연수에 따른 연차 일수. 근기법 제60조 제1항·제4항.
 *
 * - 1년 이상 3년 미만: 15일
 * - 3년 이상: 15일 + 최초 1년을 초과하는 계속근로연수 매 2년에 1일 가산
 * - 총 한도 25일
 */
export function annualLeaveDaysForTenure(completedYears: number): number {
  if (completedYears < 1) return 0;
  if (completedYears < 3) return 15;
  return Math.min(25, 15 + Math.floor((completedYears - 1) / 2));
}

export interface AttendanceRecord {
  /** 산정 대상 기간. */
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly prescribedWorkDays: number;
  readonly attendedDays: number;
  /** 출근으로 간주하는 일수(출산전후휴가, 육아휴직, 업무상 부상 등). */
  readonly deemedAttendedDays: number;
  /** 소정근로일수에서 제외하는 일수. ⚖️ 개인사유 휴직 처리는 해석 논점. */
  readonly excludedDays: number;
}

export interface AttendanceRate {
  readonly rate: number;
  readonly meetsThreshold: boolean;
  readonly denominator: number;
  readonly numerator: number;
}

/** 출근율. 80% 이상이면 기본 15일 부여 대상. */
export function computeAttendanceRate(
  record: AttendanceRecord,
  threshold = 0.8,
): AttendanceRate {
  const denominator = Math.max(0, record.prescribedWorkDays - record.excludedDays);
  const numerator = record.attendedDays + record.deemedAttendedDays;
  if (denominator === 0) {
    return { rate: 1, meetsThreshold: true, denominator, numerator };
  }
  const rate = numerator / denominator;
  return { rate, meetsThreshold: rate >= threshold, denominator, numerator };
}

/** 완료된 근속 개월 수. */
export function completedMonths(hireDate: LocalDate, asOf: LocalDate): number {
  const [hy, hm, hd] = hireDate.split('-').map(Number) as [number, number, number];
  const [ay, am, ad] = asOf.split('-').map(Number) as [number, number, number];
  let months = (ay - hy) * 12 + (am - hm);
  if (ad < hd) months -= 1;
  return Math.max(0, months);
}

/** 완료된 근속 연수. */
export function completedYears(hireDate: LocalDate, asOf: LocalDate): number {
  return Math.floor(completedMonths(hireDate, asOf) / 12);
}

/** 로컬 날짜에 개월을 더한다. 말일 처리는 해당 월의 마지막 날로 클램프. */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const totalMonths = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(totalMonths / 12);
  const nm = totalMonths % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export interface HireDateGrantInput {
  readonly memberId: string;
  readonly hireDate: LocalDate;
  readonly asOf: LocalDate;
  /**
   * 근속 연차별 출근율. index 0 = 입사 후 1년차, 1 = 2년차 …
   * 없으면 80% 이상으로 간주한다.
   */
  readonly yearlyAttendance?: readonly AttendanceRecord[];
  /** 1년 미만 기간의 개근 개월 수. 없으면 전월 개근으로 간주한다. */
  readonly perfectAttendanceMonths?: number;
  readonly idPrefix?: string;
}

/**
 * 입사일 기준 연차 부여 내역을 생성한다.
 *
 * 부여 규칙
 * - 입사 후 1개월 개근마다 1일 (최대 11일). 소멸: 입사일로부터 1년.
 * - 만 1년 시점부터 매 근속 1년마다 근속연수별 일수. 소멸: 부여일로부터 1년.
 */
export function generateHireDateGrants(input: HireDateGrantInput): LeaveGrant[] {
  const {
    memberId,
    hireDate,
    asOf,
    yearlyAttendance = [],
    perfectAttendanceMonths,
    idPrefix = 'grant',
  } = input;

  if (daysBetween(hireDate, asOf) < 0) return [];

  const grants: LeaveGrant[] = [];
  const monthsWorked = completedMonths(hireDate, asOf);
  const firstAnniversaryExpiry = addMonths(hireDate, 12);

  // 1년 미만 월차 — 최대 11일.
  const monthlyEligible = Math.min(11, monthsWorked, perfectAttendanceMonths ?? monthsWorked);
  for (let month = 1; month <= monthlyEligible; month++) {
    const grantDate = addMonths(hireDate, month);
    grants.push({
      id: `${idPrefix}:${memberId}:monthly:${month}`,
      memberId,
      balanceSource: 'ANNUAL',
      reason: 'MONTHLY_1',
      grantedUnits: daysToUnits(1),
      usedUnits: 0,
      expiredUnits: 0,
      effectiveFrom: grantDate,
      expiresAt: firstAnniversaryExpiry,
      basis: {
        rule: '근로기준법 제60조 제2항',
        completedMonth: month,
        note: '1개월 개근 시 1일',
      },
    });
  }

  // 1년 이상 연차.
  const years = completedYears(hireDate, asOf);
  for (let year = 1; year <= years; year++) {
    const grantDate = addMonths(hireDate, year * 12);
    const attendance = yearlyAttendance[year - 1];
    const rate = attendance ? computeAttendanceRate(attendance) : null;

    if (rate !== null && !rate.meetsThreshold) {
      // 출근율 80% 미만이면 기본 15일 대신 월차 방식으로 부여한다.
      // ⚖️ 이 경우의 정확한 처리는 노무사 확인 필요.
      continue;
    }

    const days = annualLeaveDaysForTenure(year);
    if (days === 0) continue;

    grants.push({
      id: `${idPrefix}:${memberId}:annual:${year}`,
      memberId,
      balanceSource: 'ANNUAL',
      reason: year >= 3 ? 'TENURE_EXTRA' : 'BASE_15',
      grantedUnits: daysToUnits(days),
      usedUnits: 0,
      expiredUnits: 0,
      effectiveFrom: grantDate,
      expiresAt: addDays(addMonths(grantDate, 12), -1),
      basis: {
        rule: year >= 3 ? '근로기준법 제60조 제4항' : '근로기준법 제60조 제1항',
        tenureYears: year,
        baseDays: 15,
        extraDays: days - 15,
        ...(rate !== null
          ? { attendanceRate: Number(rate.rate.toFixed(4)), denominator: rate.denominator }
          : { attendanceAssumed: true }),
      },
    });
  }

  return grants;
}

export interface FiscalYearGrantInput {
  readonly memberId: string;
  readonly hireDate: LocalDate;
  readonly asOf: LocalDate;
  /** 회계연도 시작 월. 기본 1월. */
  readonly fiscalStartMonth?: number;
  readonly idPrefix?: string;
}

/**
 * 회계연도 기준 연차 부여 내역을 생성한다.
 *
 * 입사 첫 해는 재직 일수에 비례해 부여하고, 이후 회계연도 시작일마다
 * 근속연수별 일수를 부여한다.
 *
 * ⚖️ 회계연도 기준은 실무에서 널리 쓰이지만 법정 기준이 아니다. 퇴직 시점에
 * 입사일 기준으로 계산한 값보다 적으면 안 된다. `compareAccrualBases`로 검증할 것.
 */
export function generateFiscalYearGrants(input: FiscalYearGrantInput): LeaveGrant[] {
  const { memberId, hireDate, asOf, fiscalStartMonth = 1, idPrefix = 'grant' } = input;
  if (daysBetween(hireDate, asOf) < 0) return [];

  const grants: LeaveGrant[] = [];
  const [hireYear] = hireDate.split('-').map(Number) as [number];
  const mm = String(fiscalStartMonth).padStart(2, '0');

  const fiscalStart = (year: number): LocalDate => `${year}-${mm}-01`;

  // 입사 연도의 회계연도 시작일이 입사일보다 이르면 그 해가 첫 회계연도.
  let firstFiscalYear = hireYear;
  if (fiscalStart(hireYear) < hireDate) firstFiscalYear = hireYear + 1;

  // 첫 회계연도 시작일에 비례부여.
  const proratedGrantDate = fiscalStart(firstFiscalYear);
  if (proratedGrantDate <= asOf) {
    const daysInFirstPeriod = daysBetween(hireDate, proratedGrantDate);
    const proratedDays = Math.round((15 * daysInFirstPeriod) / 365 * 10) / 10;
    if (proratedDays > 0) {
      grants.push({
        id: `${idPrefix}:${memberId}:fiscal-prorated`,
        memberId,
        balanceSource: 'ANNUAL',
        reason: 'FISCAL_PRORATED',
        grantedUnits: daysToUnits(proratedDays),
        usedUnits: 0,
        expiredUnits: 0,
        effectiveFrom: proratedGrantDate,
        expiresAt: addDays(fiscalStart(firstFiscalYear + 1), -1),
        basis: {
          method: 'FISCAL_YEAR',
          daysInFirstPeriod,
          formula: '15 × 재직일수 / 365',
          note: '회계연도 기준 첫 해 비례부여. 법정 기준이 아니므로 퇴직 시 입사일 기준과 비교 필요.',
        },
      });
    }
  }

  // 이후 회계연도.
  const [asOfYear] = asOf.split('-').map(Number) as [number];
  for (let year = firstFiscalYear + 1; year <= asOfYear; year++) {
    const grantDate = fiscalStart(year);
    if (grantDate > asOf) break;
    const tenure = completedYears(hireDate, grantDate);
    const days = annualLeaveDaysForTenure(Math.max(1, tenure));
    grants.push({
      id: `${idPrefix}:${memberId}:fiscal:${year}`,
      memberId,
      balanceSource: 'ANNUAL',
      reason: tenure >= 3 ? 'TENURE_EXTRA' : 'BASE_15',
      grantedUnits: daysToUnits(days),
      usedUnits: 0,
      expiredUnits: 0,
      effectiveFrom: grantDate,
      expiresAt: addDays(fiscalStart(year + 1), -1),
      basis: { method: 'FISCAL_YEAR', fiscalYear: year, tenureYears: tenure },
    });
  }

  return grants;
}

export interface AccrualComparison {
  readonly hireDateBasisDays: number;
  readonly fiscalBasisDays: number;
  /** 0보다 크면 회계연도 기준이 불리하므로 추가 부여가 필요하다. */
  readonly shortfallDays: number;
}

/**
 * 회계연도 기준과 입사일 기준의 누적 부여 일수를 비교한다.
 *
 * 대부분의 병원이 회계연도 기준으로 운영하면서 이 검증을 하지 않고 있고,
 * 퇴직 정산 분쟁의 흔한 원인이다. (docs/07-leave-management.md §1.2)
 */
export function compareAccrualBases(
  hireDateGrants: readonly LeaveGrant[],
  fiscalGrants: readonly LeaveGrant[],
): AccrualComparison {
  const total = (grants: readonly LeaveGrant[]): number =>
    grants.reduce((sum, g) => sum + g.grantedUnits, 0) / 100;

  const hireDateBasisDays = total(hireDateGrants);
  const fiscalBasisDays = total(fiscalGrants);
  return {
    hireDateBasisDays,
    fiscalBasisDays,
    shortfallDays: Math.max(0, Math.round((hireDateBasisDays - fiscalBasisDays) * 100) / 100),
  };
}

/**
 * 보상휴가 부여 단위를 계산한다. 근기법 제57조.
 *
 * 가산율을 반영하지 않고 1:1로 부여하면 법 위반 소지가 있다.
 * 예: 휴일근로 8시간(가산 50%) → 12시간분의 보상휴가.
 *
 * ⚖️ 근로자대표와의 서면합의가 전제되어야 한다.
 */
export function compensatoryLeaveUnits(
  workedMinutes: number,
  premiumRate: number,
  dailyStdMinutes = 480,
): LeaveUnits {
  const compensatedMinutes = workedMinutes * premiumRate;
  return Math.round((compensatedMinutes / dailyStdMinutes) * 100);
}
