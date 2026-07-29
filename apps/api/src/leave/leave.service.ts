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
  type LocalDate,
} from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext, tenantId } from '../common/tenant-context.js';
import { STORE, type Store } from '../store/ports.js';
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
  constructor(@Inject(STORE) private readonly store: Store) {}

  async balance(memberId: string, asOf: LocalDate): Promise<LeaveBalance> {
    const grants = await this.store.leaves.listGrants(memberId);
    return computeBalance(grants, asOf, 'ANNUAL');
  }

  grantsFor(memberId: string): Promise<TenantLeaveGrant[]> {
    return this.store.leaves.listGrants(memberId);
  }

  async create(input: CreateLeaveRequestInput): Promise<LeaveRequestResult> {
    const { memberId } = currentContext();

    const leaveType = await this.store.leaves.findLeaveType(input.leaveTypeId);
    if (leaveType === null) {
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
    let grants: TenantLeaveGrant[] = [];
    if (leaveType.deductsFromBalance) {
      grants = await this.store.leaves.listGrants(memberId);
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
    await this.store.leaves.insertRequest(request, deductions);

    // 잔액은 승인 시점이 아니라 신청 시점에 예약 차감한다.
    // 그러지 않으면 같은 잔액으로 중복 신청이 가능해진다.
    if (deductions.length > 0) {
      const updated = applyDeductions(
        grants,
        deductions.map((d) => ({ ...d, expiresAt: '9999-12-31' })),
      ) as TenantLeaveGrant[];
      await this.store.leaves.saveGrants(updated);
    }

    return {
      request,
      balanceAfter: await this.balance(memberId, input.startDate),
      warnings: await this.coverageWarnings(memberId, input.startDate, input.endDate),
    };
  }

  async cancel(requestId: string): Promise<LeaveRequest> {
    const request = await this.store.leaves.findRequest(requestId);
    if (request === null) {
      throw new ApiError('NOT_FOUND', '휴가 신청을 찾을 수 없습니다.');
    }
    if (request.memberId !== currentContext().memberId) {
      throw new ApiError('FORBIDDEN', '본인의 신청만 취소할 수 있습니다.');
    }
    if (request.status === 'CANCELLED') {
      throw new ApiError('CONFLICT', '이미 취소된 신청입니다.');
    }

    const grants = await this.store.leaves.listGrants(request.memberId);
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
    await this.store.leaves.saveGrants(restored.grants as TenantLeaveGrant[]);
    await this.store.leaves.setRequestStatus(requestId, 'CANCELLED');

    const updated: LeaveRequest = { ...request, status: 'CANCELLED' };
    await this.store.audit.append({
      actorId: currentContext().memberId,
      action: 'UPDATE',
      entityType: 'leaveRequest',
      entityId: requestId,
      reason: 'CANCELLED',
    });
    return updated;
  }

  listMine(memberId: string): Promise<LeaveRequest[]> {
    return this.store.leaves.listRequestsByMember(memberId);
  }

  /** 같은 부서에서 같은 기간에 휴가가 겹치는지 확인한다. */
  private async coverageWarnings(
    memberId: string,
    startDate: LocalDate,
    endDate: LocalDate,
  ): Promise<{ code: string; message: string }[]> {
    const member = await this.store.members.findById(memberId);
    if (member === null) return [];

    const department = await this.store.members.listByDepartment(member.departmentId);
    const colleagues = department.filter((m) => m.id !== memberId).map((m) => m.id);

    const overlapping = await this.store.leaves.listOverlappingRequests(
      colleagues,
      startDate,
      endDate,
    );
    if (overlapping.length === 0) return [];

    const byId = new Map(department.map((m) => [m.id, m.name]));
    const names = overlapping
      .map((r) => byId.get(r.memberId))
      .filter((n): n is string => n !== undefined);

    return [
      {
        code: 'TEAM_COVERAGE',
        message: `같은 기간에 휴가가 예정된 동료가 있습니다: ${names.join(', ')}`,
      },
    ];
  }

}
