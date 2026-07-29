import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_RULE_SETS,
  aggregateWeekly,
  computeDailyWorktime,
  evaluateRules,
  hasBlockingViolations,
  resolveShiftInterval,
  ruleSetsWithHealthcareException,
  type DailyWorktime,
  type EvaluatedShift,
  type EvaluationResult,
  type LocalDate,
  type RuleContext,
  type RuleSet,
  type ShiftAssignment,
  type WeeklyWorktime,
} from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { tenantId } from '../common/tenant-context.js';
import { MemoryStore } from '../store/memory-store.js';
import type { Member, Roster } from '../store/types.js';

export interface RosterDetail {
  readonly roster: Roster;
  readonly members: readonly Member[];
  readonly assignments: readonly {
    memberId: string;
    workDate: LocalDate;
    shiftCode: string;
    shiftName: string;
  }[];
  readonly evaluation: EvaluationResult;
  readonly worktime: {
    readonly daily: readonly DailyWorktime[];
    readonly weekly: readonly WeeklyWorktime[];
  };
}

@Injectable()
export class RosterService {
  constructor(@Inject(MemoryStore) private readonly store: MemoryStore) {}

  /**
   * 사업장에 적용할 규칙 세트를 구성한다.
   *
   * 특례 서면합의가 유효하면 52시간 규칙이 꺼지고 11시간 연속휴식 규칙이 켜진다.
   * 합의가 만료되면 자동으로 원래대로 돌아간다 — 이게 규칙을 데이터로 둔 이유다.
   */
  ruleSetsFor(worksiteId: string): RuleSet[] {
    const worksite = this.store
      .scoped(this.store.worksites)
      .find((w) => w.id === worksiteId);
    const agreement = worksite?.specialExceptionAgreement;
    if (agreement === undefined || agreement === null) return [...DEFAULT_RULE_SETS];
    return ruleSetsWithHealthcareException(
      worksiteId,
      agreement.effectiveFrom,
      agreement.effectiveTo,
    );
  }

  /** 근무표 하나를 계산·평가한다. 계획(PLANNED) 기준. */
  detail(rosterId: string): RosterDetail {
    const roster = this.store.scoped(this.store.rosters).find((r) => r.id === rosterId);
    if (roster === undefined) {
      throw new ApiError('NOT_FOUND', '근무표를 찾을 수 없습니다.');
    }

    const assignments = this.store
      .scoped(this.store.assignments)
      .filter((a) => a.rosterId === rosterId);
    const memberIds = [...new Set(assignments.map((a) => a.memberId))];
    const members = this.store
      .scoped(this.store.members)
      .filter((m) => memberIds.includes(m.id));
    const shiftTypes = new Map(
      this.store.scoped(this.store.shiftTypes).map((s) => [s.id, s]),
    );
    const holidays = new Set(this.store.scoped(this.store.holidays).map((h) => h.date));

    const shifts: EvaluatedShift[] = [];
    const daily: DailyWorktime[] = [];

    for (const assignment of assignments) {
      const shiftType = shiftTypes.get(assignment.shiftTypeId);
      if (shiftType === undefined) continue;

      const domainAssignment: ShiftAssignment = {
        id: assignment.id,
        memberId: assignment.memberId,
        workDate: assignment.workDate,
        shiftType,
      };
      const interval = resolveShiftInterval(domainAssignment);

      shifts.push({
        id: assignment.id,
        memberId: assignment.memberId,
        workDate: assignment.workDate,
        shiftCode: shiftType.code,
        shiftName: shiftType.name,
        interval,
        isNight: shiftType.isNight,
        isWorking:
          shiftType.countsAsWork &&
          shiftType.category !== 'OFF' &&
          shiftType.category !== 'LEAVE',
      });

      daily.push(
        computeDailyWorktime({
          memberId: assignment.memberId,
          workDate: assignment.workDate,
          interval,
          breakMinutes: shiftType.breakMinutes,
          isHoliday: holidays.has(assignment.workDate),
          dutyMode: shiftType.dutyMode,
          dutyRatio: shiftType.dutyRatio,
          paidMinutesOverride: shiftType.paidMinutesOverride,
        }),
      );
    }

    const weekly = aggregateWeekly(daily);

    // 구성원별로 평가한다. 규칙 스코프가 직군·고용형태별로 다르기 때문이다.
    const violations = members.flatMap((member) => {
      const context: RuleContext = {
        member: {
          id: member.id,
          name: member.name,
          worksiteId: member.worksiteId,
          jobFamily: member.jobFamily,
          employmentType: member.employmentType,
        },
        periodStart: roster.periodStart,
        periodEnd: roster.periodEnd,
        basis: 'PLANNED',
      };
      return evaluateRules(this.ruleSetsFor(member.worksiteId), context, {
        shifts,
        dailies: daily.map((d) => ({
          memberId: d.memberId,
          workDate: d.workDate,
          paidMinutes: d.paidMinutes,
          breakMinutes: d.breakMinutes,
        })),
        weeklies: weekly.map((w) => ({
          memberId: w.memberId,
          weekStart: w.weekStart,
          totalMinutes: w.totalMinutes,
          offDays: w.offDays,
        })),
      }).violations;
    });

    const versions = new Set<string>();
    for (const member of members) {
      for (const rs of this.ruleSetsFor(member.worksiteId)) versions.add(rs.version);
    }

    return {
      roster,
      members,
      assignments: shifts.map((s) => ({
        memberId: s.memberId,
        workDate: s.workDate,
        shiftCode: s.shiftCode,
        shiftName: s.shiftName,
      })),
      evaluation: {
        violations,
        appliedRuleSetVersions: [...versions].sort(),
        evaluatedRuleCodes: [...new Set(violations.map((v) => v.ruleCode))].sort(),
      },
      worktime: { daily, weekly },
    };
  }

  /**
   * 근무표를 확정한다.
   *
   * BLOCK 위반이 있으면 기본적으로 막되, 사유를 입력하면 진행할 수 있다.
   * 무조건 막으면 사용자가 시스템 밖에서 일하게 되고 기록이 사라진다.
   * 강행 사유와 승인자를 남기는 것이 목적이다.
   */
  publish(
    rosterId: string,
    overrides: readonly { ruleCode: string; reason: string }[],
  ): RosterDetail {
    const detail = this.detail(rosterId);
    const blocking = detail.evaluation.violations.filter((v) => v.severity === 'BLOCK');

    if (hasBlockingViolations(detail.evaluation.violations)) {
      const overriddenCodes = new Set(
        overrides.filter((o) => o.reason.trim() !== '').map((o) => o.ruleCode),
      );
      const unresolved = blocking.filter((v) => !overriddenCodes.has(v.ruleCode));
      if (unresolved.length > 0) {
        throw new ApiError(
          'RULE_VIOLATION',
          `확정할 수 없습니다. 위반 ${unresolved.length}건을 확인하거나 강행 사유를 입력하세요.`,
          {
            details: unresolved.map((v) => ({
              ruleCode: v.ruleCode,
              message: v.message,
              legalBasis: v.legalBasis ?? null,
              suggestion: v.suggestion ?? null,
              subjects: v.subjects,
            })),
          },
        );
      }
    }

    const index = this.store.rosters.findIndex(
      (r) => r.id === rosterId && r.tenantId === tenantId(),
    );
    this.store.rosters[index] = { ...this.store.rosters[index]!, status: 'PUBLISHED' };

    for (const override of overrides) {
      this.store.audit({
        actorId: null,
        action: 'UPDATE',
        entityType: 'ruleViolationOverride',
        entityId: rosterId,
        reason: `${override.ruleCode}: ${override.reason}`,
      });
    }
    this.store.audit({
      actorId: null,
      action: 'UPDATE',
      entityType: 'roster',
      entityId: rosterId,
      reason: 'PUBLISHED',
    });

    return this.detail(rosterId);
  }
}
