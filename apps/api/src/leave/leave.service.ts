import { Inject, Injectable } from '@nestjs/common';
import {
  InsufficientLeaveBalanceError,
  applyDeductions,
  computeBalance,
  daysBetween,
  daysToUnits,
  planDeduction,
  restoreDeductions,
  unitsToDays,
  type LeaveBalance,
  type LeaveGrant,
  type LocalDate,
} from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext, tenantId } from '../common/tenant-context.js';
import { MemoryStore } from '../store/memory-store.js';
import type { LeaveRequest, TenantLeaveGrant } from '../store/types.js';

export interface CreateLeaveRequestInput {
  readonly leaveTypeId: string;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly reason?: string;
  /** 반차 등 부분 사용. 미지정 시 일수 × 1일. */
  readonly unitsOverride?: number;
}

export interface LeaveRequestResult {
  readonly request: LeaveRequest;
  readonly balanceAfter: LeaveBalance;
  /** 승인자가 근무표를 따로 열어보지 않아도 영향을 알 수 있게 한다. */
  readonly warnings: readonly { code: string; message: string }[];
}

@Injectable()
export class LeaveService {
  constructor(@Inject(MemoryStore) private readonly store: MemoryStore) {}

  balance(memberId: string, asOf: LocalDate): LeaveBalance {
    const grants = this.store
      .scoped(this.store.leaveGrants)
      .filter((g) => g.memberId === memberId);
    return computeBalance(grants, asOf, 'ANNUAL');
  }

  grantsFor(memberId: string): TenantLeaveGrant[] {
    return this.store.scoped(this.store.leaveGrants).filter((g) => g.memberId === memberId);
  }

  create(input: CreateLeaveRequestInput): LeaveRequestResult {
    const { memberId } = currentContext();

    const leaveType = this.store
      .scoped(this.store.leaveTypes)
      .find((t) => t.id === input.leaveTypeId);
    if (leaveType === undefined) {
      throw new ApiError('NOT_FOUND', '휴가 종류를 찾을 수 없습니다.');
    }

    const span = daysBetween(input.startDate, input.endDate);
    if (span < 0) {
      throw new ApiError('VALIDATION_ERROR', '종료일이 시작일보다 이릅니다.');
    }

    const units = input.unitsOverride ?? daysToUnits(span + 1);
    if (units <= 0) {
      throw new ApiError('VALIDATION_ERROR', '신청 일수가 0보다 커야 합니다.');
    }

    let deductions: { grantId: string; units: number }[] = [];
    if (leaveType.deductsFromBalance) {
      const grants = this.store
        .scoped(this.store.leaveGrants)
        .filter((g) => g.memberId === memberId);
      try {
        deductions = planDeduction(grants, units, input.startDate).map((d) => ({
          grantId: d.grantId,
          units: d.units,
        }));
      } catch (error) {
        if (error instanceof InsufficientLeaveBalanceError) {
          throw new ApiError('INSUFFICIENT_BALANCE', error.message, {
            details: [
              {
                requiredDays: unitsToDays(error.requiredUnits),
                availableDays: unitsToDays(error.availableUnits),
              },
            ],
          });
        }
        throw error;
      }
    }

    const request: LeaveRequest = {
      id: this.store.nextId('lv'),
      tenantId: tenantId(),
      memberId,
      leaveTypeId: input.leaveTypeId,
      startDate: input.startDate,
      endDate: input.endDate,
      units,
      reason: input.reason ?? null,
      status: 'PENDING',
      deductions,
    };
    this.store.leaveRequests.push(request);

    // 잔액은 승인 시점이 아니라 신청 시점에 예약 차감한다.
    // 그러지 않으면 같은 잔액으로 중복 신청이 가능해진다.
    this.applyToGrants(deductions);

    return {
      request,
      balanceAfter: this.balance(memberId, input.startDate),
      warnings: this.coverageWarnings(memberId, input.startDate, input.endDate),
    };
  }

  cancel(requestId: string): LeaveRequest {
    const index = this.store.leaveRequests.findIndex(
      (r) => r.id === requestId && r.tenantId === tenantId(),
    );
    if (index === -1) {
      throw new ApiError('NOT_FOUND', '휴가 신청을 찾을 수 없습니다.');
    }
    const request = this.store.leaveRequests[index]!;
    if (request.memberId !== currentContext().memberId) {
      throw new ApiError('FORBIDDEN', '본인의 신청만 취소할 수 있습니다.');
    }
    if (request.status === 'CANCELLED') {
      throw new ApiError('CONFLICT', '이미 취소된 신청입니다.');
    }

    const grants = this.store
      .scoped(this.store.leaveGrants)
      .filter((g) => g.memberId === request.memberId);
    const restored = restoreDeductions(
      grants,
      request.deductions.map((d) => ({
        grantId: d.grantId,
        units: d.units,
        expiresAt: grants.find((g) => g.id === d.grantId)?.expiresAt ?? request.startDate,
      })),
      request.startDate,
      'CARRY_FORWARD',
    );
    this.replaceGrants(restored.grants);

    const updated: LeaveRequest = { ...request, status: 'CANCELLED' };
    this.store.leaveRequests[index] = updated;
    this.store.audit({
      actorId: currentContext().memberId,
      action: 'UPDATE',
      entityType: 'leaveRequest',
      entityId: requestId,
      reason: 'CANCELLED',
    });
    return updated;
  }

  listMine(memberId: string): LeaveRequest[] {
    return this.store
      .scoped(this.store.leaveRequests)
      .filter((r) => r.memberId === memberId)
      .sort((a, b) => b.startDate.localeCompare(a.startDate));
  }

  /** 같은 부서에서 같은 기간에 휴가가 겹치는지 확인한다. */
  private coverageWarnings(
    memberId: string,
    startDate: LocalDate,
    endDate: LocalDate,
  ): { code: string; message: string }[] {
    const member = this.store.scoped(this.store.members).find((m) => m.id === memberId);
    if (member === undefined) return [];

    const colleagues = this.store
      .scoped(this.store.members)
      .filter((m) => m.departmentId === member.departmentId && m.id !== memberId)
      .map((m) => m.id);

    const overlapping = this.store
      .scoped(this.store.leaveRequests)
      .filter(
        (r) =>
          colleagues.includes(r.memberId) &&
          r.status !== 'CANCELLED' &&
          r.status !== 'REJECTED' &&
          r.startDate <= endDate &&
          r.endDate >= startDate,
      );

    if (overlapping.length === 0) return [];

    const names = overlapping
      .map((r) => this.store.scoped(this.store.members).find((m) => m.id === r.memberId)?.name)
      .filter((n): n is string => n !== undefined);

    return [
      {
        code: 'TEAM_COVERAGE',
        message: `같은 기간에 휴가가 예정된 동료가 있습니다: ${names.join(', ')}`,
      },
    ];
  }

  private applyToGrants(deductions: readonly { grantId: string; units: number }[]): void {
    if (deductions.length === 0) return;
    const scoped = this.store.scoped(this.store.leaveGrants);
    const updated = applyDeductions(
      scoped,
      deductions.map((d) => ({ ...d, expiresAt: '9999-12-31' })),
    );
    this.replaceGrants(updated);
  }

  /** 부여 원장을 갱신한다. tenantId는 기존 행에서 보존한다. */
  private replaceGrants(updated: readonly LeaveGrant[]): void {
    for (const grant of updated) {
      const index = this.store.leaveGrants.findIndex((g) => g.id === grant.id);
      if (index === -1) continue;
      const existing = this.store.leaveGrants[index]!;
      this.store.leaveGrants[index] = { ...grant, tenantId: existing.tenantId };
    }
  }
}
