import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { toLocalDate, unitsToDays } from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext } from '../common/tenant-context.js';
import { LeaveService } from './leave.service.js';

@Controller('api/v1/leaves')
export class LeaveController {
  constructor(@Inject(LeaveService) private readonly service: LeaveService) {}

  @Get('me/balance')
  async balance(@Query('asOf') asOf?: string): Promise<unknown> {
    const { memberId } = currentContext();
    const date = asOf ?? toLocalDate(new Date());
    const balance = await this.service.balance(memberId, date);
    return {
      data: {
        asOf: balance.asOf,
        annual: {
          granted: unitsToDays(balance.grantedUnits),
          used: unitsToDays(balance.usedUnits),
          expired: unitsToDays(balance.expiredUnits),
          remaining: unitsToDays(balance.remainingUnits),
          // 소멸은 직원에게 실질적 손해다. 잔액 바로 옆에 붙여 보여준다.
          expiringSoon: balance.expiringSoon.map((e) => ({
            days: unitsToDays(e.units),
            expiresAt: e.expiresAt,
          })),
        },
      },
    };
  }

  @Post('requests')
  async create(
    @Body()
    body: {
      leaveTypeId?: string;
      startDate?: string;
      endDate?: string;
      reason?: string;
      units?: number;
    },
  ): Promise<unknown> {
    if (body.leaveTypeId === undefined || body.startDate === undefined) {
      throw new ApiError('VALIDATION_ERROR', 'leaveTypeId와 startDate는 필수입니다.');
    }
    const result = await this.service.create({
      leaveTypeId: body.leaveTypeId,
      startDate: body.startDate,
      endDate: body.endDate ?? body.startDate,
      ...(body.reason !== undefined ? { reason: body.reason } : {}),
      ...(body.units !== undefined ? { unitsOverride: body.units } : {}),
    });

    return {
      data: {
        id: result.request.id,
        status: result.request.status,
        days: unitsToDays(result.request.units),
        deductions: result.request.deductions.map((d) => ({
          grantId: d.grantId,
          days: unitsToDays(d.units),
        })),
        balanceAfter: { remaining: unitsToDays(result.balanceAfter.remainingUnits) },
        warnings: result.warnings,
      },
    };
  }

  @Get('requests')
  async list(): Promise<unknown> {
    const { memberId } = currentContext();
    return {
      data: (await this.service.listMine(memberId)).map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        startDate: r.startDate,
        endDate: r.endDate,
        days: unitsToDays(r.units),
        status: r.status,
      })),
    };
  }

  @Post('requests/:id/cancel')
  async cancel(@Param('id') id: string): Promise<unknown> {
    const request = await this.service.cancel(id);
    return { data: { id: request.id, status: request.status } };
  }
}
