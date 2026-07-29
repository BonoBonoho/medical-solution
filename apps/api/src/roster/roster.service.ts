import { Inject, Injectable } from '@nestjs/common';
import {
  DEFAULT_RULE_SETS,
  evaluateRosterPlan,
  hasBlockingViolations,
  ruleSetsWithHealthcareException,
  type DailyWorktime,
  type IdentifiedShiftType,
  type LocalDate,
  type RosterEvaluation,
  type RosterPlan,
  type RuleMember,
  type RuleSet,
  type WeeklyWorktime,
} from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext } from '../common/tenant-context.js';
import { STORE, type Store } from '../store/ports.js';
import type { Member, Roster, TenantShiftType } from '../store/types.js';

export interface RosterDetail {
  readonly roster: Roster;
  readonly members: readonly Member[];
  /**
   * 웹 그리드가 **같은 계산을 로컬에서 다시 돌리기 위한** 입력 일체.
   *
   * 편집할 때마다 서버에 물으면 느려서 못 쓰고, 웹이 계산을 따로 구현하면
   * 화면과 확정 판정이 갈라진다. 데이터를 통째로 내려주고 같은 도메인 함수를
   * 부르게 하는 것이 두 문제를 동시에 없애는 유일한 방법이다.
   */
  readonly plan: RosterPlan;
  readonly evaluation: RosterEvaluation;
}

@Injectable()
export class RosterService {
  constructor(@Inject(STORE) private readonly store: Store) {}

  /**
   * 사업장에 적용할 규칙 세트를 구성한다.
   *
   * 특례 서면합의가 유효하면 52시간 규칙이 꺼지고 11시간 연속휴식 규칙이 켜진다.
   * 합의가 만료되면 자동으로 원래대로 돌아간다 — 이게 규칙을 데이터로 둔 이유다.
   */
  async ruleSetsFor(worksiteId: string): Promise<RuleSet[]> {
    const worksite = await this.store.worksites.findById(worksiteId);
    const agreement = worksite?.specialExceptionAgreement;
    if (agreement === undefined || agreement === null) return [...DEFAULT_RULE_SETS];
    return ruleSetsWithHealthcareException(
      worksiteId,
      agreement.effectiveFrom,
      agreement.effectiveTo,
    );
  }

  /** 근무표 하나를 계산·평가한다. 계획(PLANNED) 기준. */
  async detail(rosterId: string): Promise<RosterDetail> {
    const roster = await this.store.rosters.findById(rosterId);
    if (roster === null) {
      throw new ApiError('NOT_FOUND', '근무표를 찾을 수 없습니다.');
    }

    const assignments = await this.store.rosters.listAssignments(rosterId);
    const memberIds = [...new Set(assignments.map((a) => a.memberId))];
    const members = await this.store.members.listByIds(memberIds);
    const shiftTypes = await this.store.rosters.listShiftTypes();
    const holidays = await this.store.rosters.listHolidays();

    const ruleSetsByWorksite: Record<string, RuleSet[]> = {};
    for (const worksiteId of new Set(members.map((m) => m.worksiteId))) {
      ruleSetsByWorksite[worksiteId] = await this.ruleSetsFor(worksiteId);
    }

    const plan: RosterPlan = {
      periodStart: roster.periodStart,
      periodEnd: roster.periodEnd,
      members: members.map(toRuleMember),
      shiftTypes: shiftTypes.map(toIdentifiedShiftType),
      assignments: assignments.map((a) => ({
        id: a.id,
        memberId: a.memberId,
        workDate: a.workDate,
        shiftTypeId: a.shiftTypeId,
      })),
      holidays: holidays.map((h) => h.date),
      ruleSetsByWorksite,
      basis: 'PLANNED',
    };

    return { roster, members, plan, evaluation: evaluateRosterPlan(plan) };
  }

  /**
   * 근무표를 확정한다.
   *
   * BLOCK 위반이 있으면 기본적으로 막되, 사유를 입력하면 진행할 수 있다.
   * 무조건 막으면 사용자가 시스템 밖에서 일하게 되고 기록이 사라진다.
   * 강행 사유와 승인자를 남기는 것이 목적이다.
   */
  async publish(
    rosterId: string,
    overrides: readonly { ruleCode: string; reason: string }[],
  ): Promise<RosterDetail> {
    const detail = await this.detail(rosterId);
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

    await this.store.rosters.setStatus(rosterId, 'PUBLISHED');

    // 강행 확정은 누가 했는지가 기록의 핵심이다. 근로감독 대응 시
    // "위반을 알고도 확정한 사람과 그 사유"가 남아 있어야 한다.
    const actorId = currentContext().memberId;
    for (const override of overrides) {
      await this.store.audit.append({
        actorId,
        action: 'OVERRIDE',
        entityType: 'ruleViolationOverride',
        entityId: rosterId,
        reason: `${override.ruleCode}: ${override.reason}`,
      });
    }
    await this.store.audit.append({
      actorId,
      action: 'UPDATE',
      entityType: 'roster',
      entityId: rosterId,
      reason: 'PUBLISHED',
    });

    return this.detail(rosterId);
  }
}

/** 저장소의 Member에서 규칙 평가에 필요한 필드만 뽑는다. 개인정보는 넘기지 않는다. */
function toRuleMember(member: Member): RuleMember {
  return {
    id: member.id,
    name: member.name,
    worksiteId: member.worksiteId,
    jobFamily: member.jobFamily,
    employmentType: member.employmentType,
  };
}

/** tenantId를 떼어낸다. 도메인 계산에 테넌트는 필요 없고, 웹으로 새어나갈 이유도 없다. */
function toIdentifiedShiftType(shiftType: TenantShiftType): IdentifiedShiftType {
  const { tenantId: _tenantId, ...rest } = shiftType;
  return rest;
}
