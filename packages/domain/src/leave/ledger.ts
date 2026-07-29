/**
 * 연차 부여 원장(Grant Ledger).
 *
 * 잔액을 단일 숫자로 두지 않고 부여 건별 원장으로 관리하는 이유:
 * 1. 연차는 발생일마다 소멸일이 다르다. 선입선출 차감이 필요하다.
 * 2. 사용촉진·미사용수당 정산 시 "어느 연차가 언제 소멸했는지" 증빙해야 한다.
 * 3. 단일 잔액 컬럼은 동시성 문제와 감사 추적 불가 문제를 동시에 일으킨다.
 * (docs/04-data-model.md §6)
 */

import type { LocalDate } from '../time/interval.js';
import type { BalanceSource, LeaveGrant } from './accrual.js';
import { type LeaveUnits, formatUnits } from './units.js';

export interface Deduction {
  readonly grantId: string;
  readonly units: LeaveUnits;
  readonly expiresAt: LocalDate;
}

export class InsufficientLeaveBalanceError extends Error {
  constructor(
    readonly requiredUnits: LeaveUnits,
    readonly availableUnits: LeaveUnits,
  ) {
    super(
      `잔여 휴가가 부족합니다. 필요 ${formatUnits(requiredUnits)}, ` +
        `사용 가능 ${formatUnits(availableUnits)}`,
    );
    this.name = 'InsufficientLeaveBalanceError';
  }
}

function remainingUnits(grant: LeaveGrant): LeaveUnits {
  return grant.grantedUnits - grant.usedUnits - grant.expiredUnits;
}

function isUsableOn(grant: LeaveGrant, date: LocalDate): boolean {
  return grant.effectiveFrom <= date && grant.expiresAt >= date && remainingUnits(grant) > 0;
}

/**
 * 사용 가능한 부여 건을 소멸임박 순으로 정렬한다.
 *
 * 소멸임박 우선 차감이 직원에게 유리하다. 나중에 소멸할 연차를 먼저 쓰면
 * 임박한 연차가 그냥 소멸해버린다.
 */
export function usableGrants(
  grants: readonly LeaveGrant[],
  useDate: LocalDate,
  source: BalanceSource = 'ANNUAL',
): LeaveGrant[] {
  return grants
    .filter((g) => g.balanceSource === source && isUsableOn(g, useDate))
    .sort((a, b) =>
      a.expiresAt === b.expiresAt
        ? a.effectiveFrom.localeCompare(b.effectiveFrom)
        : a.expiresAt.localeCompare(b.expiresAt),
    );
}

/** 선입선출(소멸임박 우선)로 차감 내역을 계산한다. 부여 건을 변경하지 않는다. */
export function planDeduction(
  grants: readonly LeaveGrant[],
  requiredUnits: LeaveUnits,
  useDate: LocalDate,
  source: BalanceSource = 'ANNUAL',
): Deduction[] {
  if (requiredUnits <= 0) return [];

  const available = usableGrants(grants, useDate, source);
  const totalAvailable = available.reduce((sum, g) => sum + remainingUnits(g), 0);
  if (totalAvailable < requiredUnits) {
    throw new InsufficientLeaveBalanceError(requiredUnits, totalAvailable);
  }

  const deductions: Deduction[] = [];
  let outstanding = requiredUnits;
  for (const grant of available) {
    if (outstanding <= 0) break;
    const take = Math.min(remainingUnits(grant), outstanding);
    deductions.push({ grantId: grant.id, units: take, expiresAt: grant.expiresAt });
    outstanding -= take;
  }
  return deductions;
}

/** 차감 내역을 부여 건에 반영한 새 배열을 돌려준다. 입력을 변경하지 않는다. */
export function applyDeductions(
  grants: readonly LeaveGrant[],
  deductions: readonly Deduction[],
): LeaveGrant[] {
  const byGrantId = new Map<string, LeaveUnits>();
  for (const d of deductions) {
    byGrantId.set(d.grantId, (byGrantId.get(d.grantId) ?? 0) + d.units);
  }
  return grants.map((g) => {
    const delta = byGrantId.get(g.id);
    return delta === undefined ? g : { ...g, usedUnits: g.usedUnits + delta };
  });
}

/** 취소 시 원래 부여 건이 이미 소멸한 경우의 처리 정책. */
export type RestorePolicy =
  /** 소멸 처리. 직원에게 불리. */
  | 'FORFEIT'
  /** 현재 유효한 부여 건으로 이월. 직원에게 유리. 기본값. */
  | 'CARRY_FORWARD';

export interface RestoreResult {
  readonly grants: LeaveGrant[];
  /** 소멸로 인해 복원되지 못한 단위. */
  readonly forfeitedUnits: LeaveUnits;
  /** 다른 부여 건으로 이월된 단위. */
  readonly carriedForwardUnits: LeaveUnits;
}

/** 휴가 취소 시 차감을 되돌린다. */
export function restoreDeductions(
  grants: readonly LeaveGrant[],
  deductions: readonly Deduction[],
  cancelDate: LocalDate,
  policy: RestorePolicy = 'CARRY_FORWARD',
): RestoreResult {
  let working = [...grants];
  let forfeitedUnits = 0;
  let carriedForwardUnits = 0;

  for (const deduction of deductions) {
    const index = working.findIndex((g) => g.id === deduction.grantId);
    if (index === -1) {
      forfeitedUnits += deduction.units;
      continue;
    }
    const grant = working[index]!;

    if (grant.expiresAt >= cancelDate) {
      working[index] = { ...grant, usedUnits: Math.max(0, grant.usedUnits - deduction.units) };
      continue;
    }

    // 원래 부여 건이 이미 소멸했다.
    if (policy === 'FORFEIT') {
      forfeitedUnits += deduction.units;
      continue;
    }

    // 사용 기록은 되돌리고 소멸 처리로 옮긴 뒤, 현재 유효한 건으로 이월한다.
    working[index] = {
      ...grant,
      usedUnits: Math.max(0, grant.usedUnits - deduction.units),
      expiredUnits: grant.expiredUnits + deduction.units,
    };
    const target = usableGrants(working, cancelDate, grant.balanceSource)[0];
    if (target === undefined) {
      forfeitedUnits += deduction.units;
      continue;
    }
    const targetIndex = working.findIndex((g) => g.id === target.id);
    working[targetIndex] = {
      ...target,
      grantedUnits: target.grantedUnits + deduction.units,
    };
    carriedForwardUnits += deduction.units;
  }

  return { grants: working, forfeitedUnits, carriedForwardUnits };
}

export interface ExpiringSoon {
  readonly units: LeaveUnits;
  readonly expiresAt: LocalDate;
}

export interface LeaveBalance {
  readonly asOf: LocalDate;
  readonly source: BalanceSource;
  readonly grantedUnits: LeaveUnits;
  readonly usedUnits: LeaveUnits;
  readonly expiredUnits: LeaveUnits;
  readonly remainingUnits: LeaveUnits;
  /** 지정 기간 내 소멸 예정. 소멸은 직원에게 실질적 손해다. */
  readonly expiringSoon: readonly ExpiringSoon[];
}

export function computeBalance(
  grants: readonly LeaveGrant[],
  asOf: LocalDate,
  source: BalanceSource = 'ANNUAL',
  expiringWithinDays = 90,
): LeaveBalance {
  const scoped = grants.filter((g) => g.balanceSource === source && g.effectiveFrom <= asOf);

  const grantedUnits = scoped.reduce((s, g) => s + g.grantedUnits, 0);
  const usedUnits = scoped.reduce((s, g) => s + g.usedUnits, 0);

  // 소멸일이 지난 미사용분은 소멸로 계산한다.
  const expiredUnits = scoped.reduce((s, g) => {
    if (g.expiresAt >= asOf) return s + g.expiredUnits;
    return s + g.expiredUnits + Math.max(0, remainingUnits(g));
  }, 0);

  const horizon = shiftDate(asOf, expiringWithinDays);
  const expiringSoon = scoped
    .filter((g) => g.expiresAt >= asOf && g.expiresAt <= horizon && remainingUnits(g) > 0)
    .map((g) => ({ units: remainingUnits(g), expiresAt: g.expiresAt }))
    .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  return {
    asOf,
    source,
    grantedUnits,
    usedUnits,
    expiredUnits,
    remainingUnits: grantedUnits - usedUnits - expiredUnits,
    expiringSoon,
  };
}

function shiftDate(date: LocalDate, days: number): LocalDate {
  const t = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 3교대 근무자의 연차 1일을 몇 시간으로 볼지의 정책.
 *
 * ⚖️ 근로자에게 불리한 방식은 취업규칙 불이익 변경 절차가 필요할 수 있다.
 * 기본값은 직원에게 유리한 SHIFT_LENGTH.
 */
export type LeaveDayEquivalence =
  /** 연차 1일 = 8시간. 12시간 시프트에 쓰면 1.5일 차감. 기관 유리. */
  | 'FIXED_8H'
  /** 연차 1일 = 해당 시프트 길이. 12시간 써도 1일 차감. 직원 유리. */
  | 'SHIFT_LENGTH'
  /** 연차 1일 = 근로계약상 1일 소정근로시간. */
  | 'CONTRACTUAL_DAILY';

/** 시프트 하나에 연차를 사용할 때 차감할 단위를 계산한다. */
export function leaveUnitsForShift(
  shiftMinutes: number,
  policy: LeaveDayEquivalence,
  options: { readonly contractualDailyMinutes?: number } = {},
): LeaveUnits {
  const { contractualDailyMinutes = 480 } = options;
  switch (policy) {
    case 'SHIFT_LENGTH':
      return 100;
    case 'FIXED_8H':
      return Math.round((shiftMinutes / 480) * 100);
    case 'CONTRACTUAL_DAILY':
      return Math.round((shiftMinutes / contractualDailyMinutes) * 100);
  }
}
