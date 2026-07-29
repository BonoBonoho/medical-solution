import { describe, expect, it } from 'vitest';
import {
  InsufficientLeaveBalanceError,
  addMonths,
  annualLeaveDaysForTenure,
  applyDeductions,
  compareAccrualBases,
  compensatoryLeaveUnits,
  completedMonths,
  completedYears,
  computeAttendanceRate,
  computeBalance,
  daysToUnits,
  generateFiscalYearGrants,
  generateHireDateGrants,
  leaveUnitsForShift,
  planDeduction,
  restoreDeductions,
  unitsToDays,
  usableGrants,
  type LeaveGrant,
} from '../src/index.js';

describe('근속연수별 연차 일수 (근기법 §60)', () => {
  it('1년 미만은 0일 (월차로 별도 부여)', () => {
    expect(annualLeaveDaysForTenure(0)).toBe(0);
  });

  it('1~2년차는 15일', () => {
    expect(annualLeaveDaysForTenure(1)).toBe(15);
    expect(annualLeaveDaysForTenure(2)).toBe(15);
  });

  it('3년차부터 매 2년 1일 가산', () => {
    expect(annualLeaveDaysForTenure(3)).toBe(16);
    expect(annualLeaveDaysForTenure(4)).toBe(16);
    expect(annualLeaveDaysForTenure(5)).toBe(17);
    expect(annualLeaveDaysForTenure(7)).toBe(18);
  });

  it('25일이 한도다', () => {
    expect(annualLeaveDaysForTenure(21)).toBe(25);
    expect(annualLeaveDaysForTenure(23)).toBe(25);
    expect(annualLeaveDaysForTenure(40)).toBe(25);
  });
});

describe('근속 기간 계산', () => {
  it('개월 수는 일자를 채워야 인정된다', () => {
    expect(completedMonths('2026-01-15', '2026-02-14')).toBe(0);
    expect(completedMonths('2026-01-15', '2026-02-15')).toBe(1);
    expect(completedMonths('2026-01-15', '2027-01-15')).toBe(12);
  });

  it('연수는 개월 수 기준이다', () => {
    expect(completedYears('2026-01-15', '2027-01-14')).toBe(0);
    expect(completedYears('2026-01-15', '2027-01-15')).toBe(1);
  });

  it('월 더하기는 말일을 클램프한다', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29'); // 윤년
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('2/29 입사자의 근속을 계산한다', () => {
    expect(completedYears('2028-02-29', '2029-02-28')).toBe(0);
    expect(completedYears('2028-02-29', '2029-03-01')).toBe(1);
  });
});

describe('출근율', () => {
  it('80% 이상이면 기본 연차 대상이다', () => {
    const rate = computeAttendanceRate({
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      prescribedWorkDays: 248,
      attendedDays: 231,
      deemedAttendedDays: 0,
      excludedDays: 0,
    });
    expect(rate.meetsThreshold).toBe(true);
    expect(rate.rate).toBeCloseTo(0.9315, 4);
  });

  it('출산휴가 등 간주 출근일을 분자에 포함한다', () => {
    const rate = computeAttendanceRate({
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      prescribedWorkDays: 248,
      attendedDays: 150,
      deemedAttendedDays: 90,
      excludedDays: 0,
    });
    expect(rate.meetsThreshold).toBe(true);
  });

  it('제외일은 분모에서 뺀다', () => {
    const rate = computeAttendanceRate({
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      prescribedWorkDays: 248,
      attendedDays: 100,
      deemedAttendedDays: 0,
      excludedDays: 130,
    });
    expect(rate.denominator).toBe(118);
    expect(rate.meetsThreshold).toBe(true);
  });

  it('80% 미만이면 기본 연차 대상이 아니다', () => {
    const rate = computeAttendanceRate({
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      prescribedWorkDays: 248,
      attendedDays: 150,
      deemedAttendedDays: 0,
      excludedDays: 0,
    });
    expect(rate.meetsThreshold).toBe(false);
  });
});

describe('입사일 기준 부여', () => {
  it('입사 1개월 미만은 부여가 없다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2026-01-15',
      asOf: '2026-02-10',
    });
    expect(grants).toHaveLength(0);
  });

  it('1년 미만은 개근 월마다 1일, 최대 11일', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2026-01-15',
      asOf: '2026-12-31',
    });
    const monthly = grants.filter((g) => g.reason === 'MONTHLY_1');
    expect(monthly).toHaveLength(11);
    expect(monthly.every((g) => g.grantedUnits === daysToUnits(1))).toBe(true);
    // 월차는 입사일로부터 1년간 사용
    expect(monthly[0]!.expiresAt).toBe('2027-01-15');
  });

  it('개근하지 못한 달은 부여하지 않는다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2026-01-15',
      asOf: '2026-12-31',
      perfectAttendanceMonths: 8,
    });
    expect(grants.filter((g) => g.reason === 'MONTHLY_1')).toHaveLength(8);
  });

  it('만 1년 시점에 15일이 부여된다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2026-01-15',
      asOf: '2027-01-15',
    });
    const annual = grants.filter((g) => g.reason === 'BASE_15');
    expect(annual).toHaveLength(1);
    expect(unitsToDays(annual[0]!.grantedUnits)).toBe(15);
    expect(annual[0]!.effectiveFrom).toBe('2027-01-15');
    expect(annual[0]!.expiresAt).toBe('2028-01-14');
  });

  it('3년차 경계에서 16일로 늘어난다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2023-01-15',
      asOf: '2026-01-15',
    });
    const byYear = grants
      .filter((g) => g.reason === 'BASE_15' || g.reason === 'TENURE_EXTRA')
      .map((g) => unitsToDays(g.grantedUnits));
    expect(byYear).toEqual([15, 15, 16]);
  });

  it('출근율 80% 미만인 해는 기본 연차를 부여하지 않는다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2025-01-15',
      asOf: '2026-01-15',
      yearlyAttendance: [
        {
          periodStart: '2025-01-15',
          periodEnd: '2026-01-14',
          prescribedWorkDays: 248,
          attendedDays: 100,
          deemedAttendedDays: 0,
          excludedDays: 0,
        },
      ],
    });
    expect(grants.filter((g) => g.reason === 'BASE_15')).toHaveLength(0);
  });

  it('산정 근거를 남긴다 — 왜 이만큼 받았는지 답할 수 있어야 한다', () => {
    const grants = generateHireDateGrants({
      memberId: 'm1',
      hireDate: '2020-01-15',
      asOf: '2026-01-15',
    });
    const latest = grants[grants.length - 1]!;
    expect(latest.basis['rule']).toBe('근로기준법 제60조 제4항');
    expect(latest.basis['tenureYears']).toBe(6);
    expect(latest.basis['extraDays']).toBe(2);
  });
});

describe('회계연도 기준 부여', () => {
  it('첫 해는 재직 일수에 비례해 부여한다', () => {
    const grants = generateFiscalYearGrants({
      memberId: 'm1',
      hireDate: '2026-07-01',
      asOf: '2027-01-01',
    });
    const prorated = grants.find((g) => g.reason === 'FISCAL_PRORATED');
    expect(prorated).toBeDefined();
    // 2026-07-01 ~ 2027-01-01 = 184일 → 15 × 184/365 ≈ 7.6일
    expect(unitsToDays(prorated!.grantedUnits)).toBeCloseTo(7.6, 1);
  });

  it('입사일 기준과 비교해 부족분을 검출한다', () => {
    const hireDate = '2026-07-01';
    const asOf = '2027-08-01';
    const hireBasis = generateHireDateGrants({ memberId: 'm1', hireDate, asOf });
    const fiscalBasis = generateFiscalYearGrants({ memberId: 'm1', hireDate, asOf });
    const comparison = compareAccrualBases(hireBasis, fiscalBasis);
    expect(comparison.hireDateBasisDays).toBeGreaterThan(0);
    expect(comparison.fiscalBasisDays).toBeGreaterThan(0);
    // 부족분이 있으면 퇴직 정산 시 추가 부여가 필요하다
    expect(comparison.shortfallDays).toBeGreaterThanOrEqual(0);
  });
});

describe('부여 원장 차감', () => {
  const grant = (
    id: string,
    days: number,
    effectiveFrom: string,
    expiresAt: string,
    used = 0,
  ): LeaveGrant => ({
    id,
    memberId: 'm1',
    balanceSource: 'ANNUAL',
    reason: 'BASE_15',
    grantedUnits: daysToUnits(days),
    usedUnits: daysToUnits(used),
    expiredUnits: 0,
    effectiveFrom,
    expiresAt,
    basis: {},
  });

  const grants = [
    grant('g-late', 10, '2026-01-01', '2026-12-31'),
    grant('g-soon', 3, '2026-01-01', '2026-08-31'),
  ];

  it('소멸임박 건부터 차감한다 — 직원에게 유리하다', () => {
    const plan = planDeduction(grants, daysToUnits(2), '2026-07-29');
    expect(plan).toHaveLength(1);
    expect(plan[0]!.grantId).toBe('g-soon');
  });

  it('한 건으로 부족하면 다음 건으로 넘어간다', () => {
    const plan = planDeduction(grants, daysToUnits(5), '2026-07-29');
    expect(plan.map((d) => d.grantId)).toEqual(['g-soon', 'g-late']);
    expect(unitsToDays(plan[0]!.units)).toBe(3);
    expect(unitsToDays(plan[1]!.units)).toBe(2);
  });

  it('잔액이 부족하면 오류를 던진다', () => {
    expect(() => planDeduction(grants, daysToUnits(20), '2026-07-29')).toThrow(
      InsufficientLeaveBalanceError,
    );
  });

  it('소멸한 건은 차감 대상이 아니다', () => {
    const usable = usableGrants(grants, '2026-10-01');
    expect(usable.map((g) => g.id)).toEqual(['g-late']);
  });

  it('발효 전 건은 차감 대상이 아니다', () => {
    const usable = usableGrants(grants, '2025-12-31');
    expect(usable).toHaveLength(0);
  });

  it('차감을 적용해도 원본 배열을 변경하지 않는다', () => {
    const plan = planDeduction(grants, daysToUnits(2), '2026-07-29');
    const applied = applyDeductions(grants, plan);
    expect(grants[1]!.usedUnits).toBe(0);
    expect(applied.find((g) => g.id === 'g-soon')!.usedUnits).toBe(daysToUnits(2));
  });

  it('반차·반반차를 섞어도 소수점 오차가 없다', () => {
    let current = [grant('g1', 3, '2026-01-01', '2026-12-31')];
    // 0.25일을 12번 = 정확히 3일
    for (let i = 0; i < 12; i++) {
      const plan = planDeduction(current, 25, '2026-07-29');
      current = applyDeductions(current, plan);
    }
    const balance = computeBalance(current, '2026-07-29');
    expect(balance.remainingUnits).toBe(0);
    expect(unitsToDays(balance.usedUnits)).toBe(3);
    expect(() => planDeduction(current, 25, '2026-07-29')).toThrow(
      InsufficientLeaveBalanceError,
    );
  });
});

describe('취소 시 복원', () => {
  const grant = (id: string, days: number, expiresAt: string, used: number): LeaveGrant => ({
    id,
    memberId: 'm1',
    balanceSource: 'ANNUAL',
    reason: 'BASE_15',
    grantedUnits: daysToUnits(days),
    usedUnits: daysToUnits(used),
    expiredUnits: 0,
    effectiveFrom: '2026-01-01',
    expiresAt,
    basis: {},
  });

  it('유효한 건은 그대로 되돌린다', () => {
    const grants = [grant('g1', 15, '2026-12-31', 3)];
    const result = restoreDeductions(
      grants,
      [{ grantId: 'g1', units: daysToUnits(2), expiresAt: '2026-12-31' }],
      '2026-07-29',
    );
    expect(unitsToDays(result.grants[0]!.usedUnits)).toBe(1);
    expect(result.forfeitedUnits).toBe(0);
  });

  it('CARRY_FORWARD면 소멸한 건의 차감분을 유효한 건으로 이월한다', () => {
    const grants = [
      grant('g-expired', 5, '2026-06-30', 2),
      grant('g-current', 15, '2027-06-30', 0),
    ];
    const result = restoreDeductions(
      grants,
      [{ grantId: 'g-expired', units: daysToUnits(2), expiresAt: '2026-06-30' }],
      '2026-07-29',
      'CARRY_FORWARD',
    );
    expect(result.carriedForwardUnits).toBe(daysToUnits(2));
    expect(unitsToDays(result.grants.find((g) => g.id === 'g-current')!.grantedUnits)).toBe(17);
  });

  it('FORFEIT이면 소멸 처리한다', () => {
    const grants = [
      grant('g-expired', 5, '2026-06-30', 2),
      grant('g-current', 15, '2027-06-30', 0),
    ];
    const result = restoreDeductions(
      grants,
      [{ grantId: 'g-expired', units: daysToUnits(2), expiresAt: '2026-06-30' }],
      '2026-07-29',
      'FORFEIT',
    );
    expect(result.forfeitedUnits).toBe(daysToUnits(2));
    expect(result.carriedForwardUnits).toBe(0);
  });
});

describe('잔액 조회', () => {
  it('소멸일이 지난 미사용분을 소멸로 계산한다', () => {
    const grants: LeaveGrant[] = [
      {
        id: 'g1',
        memberId: 'm1',
        balanceSource: 'ANNUAL',
        reason: 'BASE_15',
        grantedUnits: daysToUnits(15),
        usedUnits: daysToUnits(10),
        expiredUnits: 0,
        effectiveFrom: '2025-01-01',
        expiresAt: '2025-12-31',
        basis: {},
      },
    ];
    const balance = computeBalance(grants, '2026-07-29');
    expect(unitsToDays(balance.expiredUnits)).toBe(5);
    expect(balance.remainingUnits).toBe(0);
  });

  it('소멸임박 건을 소멸일 순으로 알려준다', () => {
    const grants: LeaveGrant[] = [
      {
        id: 'g1',
        memberId: 'm1',
        balanceSource: 'ANNUAL',
        reason: 'BASE_15',
        grantedUnits: daysToUnits(15),
        usedUnits: daysToUnits(12),
        expiredUnits: 0,
        effectiveFrom: '2026-01-01',
        expiresAt: '2026-08-31',
        basis: {},
      },
    ];
    const balance = computeBalance(grants, '2026-07-29', 'ANNUAL', 90);
    expect(balance.expiringSoon).toHaveLength(1);
    expect(unitsToDays(balance.expiringSoon[0]!.units)).toBe(3);
    expect(balance.expiringSoon[0]!.expiresAt).toBe('2026-08-31');
  });
});

describe('3교대 연차 환산', () => {
  it('SHIFT_LENGTH는 시프트 길이와 무관하게 1일 차감한다 (직원 유리, 기본값)', () => {
    expect(leaveUnitsForShift(720, 'SHIFT_LENGTH')).toBe(100);
    expect(leaveUnitsForShift(480, 'SHIFT_LENGTH')).toBe(100);
  });

  it('FIXED_8H는 12시간 시프트에 1.5일을 차감한다 (기관 유리)', () => {
    expect(leaveUnitsForShift(720, 'FIXED_8H')).toBe(150);
    expect(leaveUnitsForShift(480, 'FIXED_8H')).toBe(100);
  });

  it('CONTRACTUAL_DAILY는 계약상 소정근로시간을 기준으로 한다', () => {
    expect(leaveUnitsForShift(720, 'CONTRACTUAL_DAILY', { contractualDailyMinutes: 360 })).toBe(200);
  });
});

describe('보상휴가', () => {
  it('가산율을 반영한다 — 1:1 부여는 법 위반 소지가 있다', () => {
    // 휴일근로 8시간, 가산 50% → 12시간분 = 1.5일
    expect(unitsToDays(compensatoryLeaveUnits(480, 1.5))).toBe(1.5);
  });

  it('연장·야간 중복 가산도 계수로 표현한다', () => {
    // 연장 50% + 야간 50% = 200%
    expect(unitsToDays(compensatoryLeaveUnits(240, 2.0))).toBe(1);
  });
});
