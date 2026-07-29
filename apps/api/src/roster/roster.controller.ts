import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { RosterService } from './roster.service.js';
import { ApiError } from '../common/errors.js';
import { hasRole } from '../common/tenant-context.js';

@Controller('api/v1/rosters')
export class RosterController {
  constructor(@Inject(RosterService) private readonly service: RosterService) {}

  @Get(':id')
  async detail(@Param('id') id: string): Promise<unknown> {
    return { data: present(await this.service.detail(id)) };
  }

  @Post(':id/publish')
  async publish(
    @Param('id') id: string,
    @Body() body: { overrideViolations?: { ruleCode: string; reason: string }[] },
  ): Promise<unknown> {
    if (!hasRole('WARD_MANAGER') && !hasRole('HR_MANAGER') && !hasRole('SUPER_ADMIN')) {
      throw new ApiError('FORBIDDEN', '근무표를 확정할 권한이 없습니다.');
    }
    return { data: present(await this.service.publish(id, body.overrideViolations ?? [])) };
  }
}

function present(detail: Awaited<ReturnType<RosterService['detail']>>): unknown {
  return {
    id: detail.roster.id,
    status: detail.roster.status,
    period: { start: detail.roster.periodStart, end: detail.roster.periodEnd },
    members: detail.members.map((m) => ({
      id: m.id,
      name: m.name,
      jobFamily: m.jobFamily,
    })),
    assignments: detail.assignments,
    violations: detail.evaluation.violations.map((v) => ({
      ruleCode: v.ruleCode,
      severity: v.severity,
      message: v.message,
      legalBasis: v.legalBasis ?? null,
      suggestion: v.suggestion ?? null,
      subjects: v.subjects,
    })),
    ruleSetVersions: detail.evaluation.appliedRuleSetVersions,
    weekly: detail.worktime.weekly.map((w) => ({
      memberId: w.memberId,
      weekStart: w.weekStart,
      totalMinutes: w.totalMinutes,
      overtimeMinutes: w.overtimeMinutes,
      nightMinutes: w.nightMinutes,
      offDays: w.offDays,
    })),
  };
}
