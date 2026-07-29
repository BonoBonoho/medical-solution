/** 규칙 엔진. RuleSet 해석 → 평가기 실행 → 위반 목록 산출. */

import { EVALUATORS } from './evaluators.js';
import type {
  RuleCode,
  RuleContext,
  RuleDefinition,
  RuleEvaluationData,
  RuleSet,
  Severity,
  Violation,
} from './types.js';

/**
 * 적용 대상 RuleSet을 스코프·시행일로 걸러 우선순위대로 정렬한다.
 * 좁은 스코프가 넓은 스코프를 덮어쓴다.
 */
export function resolveRuleSets(
  ruleSets: readonly RuleSet[],
  context: RuleContext,
): RuleSet[] {
  const { member, periodStart } = context;

  return ruleSets
    .filter((rs) => {
      if (!rs.isActive) return false;
      if (rs.effectiveFrom > periodStart) return false;
      if (rs.effectiveTo !== undefined && rs.effectiveTo < periodStart) return false;

      const { worksiteId, jobFamily, employmentType } = rs.scope;
      if (worksiteId !== undefined && worksiteId !== member.worksiteId) return false;
      if (jobFamily !== undefined && jobFamily !== member.jobFamily) return false;
      if (employmentType !== undefined && employmentType !== member.employmentType) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 우선순위가 같으면 최근 시행 규칙이 뒤에 와서 덮어쓴다.
      return a.effectiveFrom.localeCompare(b.effectiveFrom);
    });
}

export interface ResolvedRule extends RuleDefinition {
  readonly ruleSetId: string;
  readonly ruleSetVersion: string;
}

/**
 * 규칙 인스턴스의 해석 키.
 *
 * 같은 코드라도 instanceKey가 다르면 별개의 규칙으로 취급한다.
 * 상위 우선순위 규칙 세트는 같은 키를 써야 덮어쓸 수 있다.
 */
export function ruleInstanceKey(rule: RuleDefinition): string {
  return rule.instanceKey === undefined ? rule.code : `${rule.code}#${rule.instanceKey}`;
}

/** 최종 적용될 규칙 인스턴스를 확정한다. 키는 `ruleInstanceKey`. */
export function resolveRules(
  ruleSets: readonly RuleSet[],
  context: RuleContext,
): Map<string, ResolvedRule> {
  const resolved = new Map<string, ResolvedRule>();

  for (const ruleSet of resolveRuleSets(ruleSets, context)) {
    for (const rule of ruleSet.rules) {
      // 비활성 규칙도 일단 맵에 넣는다. 상위 규칙 세트가 하위 규칙을 끄는
      // 용도로 쓰기 때문이다(특례 적용 시 WEEKLY_MAX_MINUTES를 끄는 케이스).
      resolved.set(ruleInstanceKey(rule), {
        ...rule,
        ruleSetId: ruleSet.id,
        ruleSetVersion: ruleSet.version,
      });
    }
  }

  for (const [key, rule] of resolved) {
    if (!rule.enabled) resolved.delete(key);
  }
  return resolved;
}

export interface EvaluationResult {
  readonly violations: readonly Violation[];
  /** 적용된 규칙 세트 버전. 재현성을 위해 집계 결과와 함께 저장한다. */
  readonly appliedRuleSetVersions: readonly string[];
  readonly evaluatedRuleCodes: readonly RuleCode[];
}

export function evaluateRules(
  ruleSets: readonly RuleSet[],
  context: RuleContext,
  data: RuleEvaluationData,
): EvaluationResult {
  const resolved = resolveRules(ruleSets, context);
  const violations: Violation[] = [];
  const versions = new Set<string>();
  const codes = new Set<RuleCode>();

  for (const rule of resolved.values()) {
    const evaluator = EVALUATORS[rule.code];
    if (evaluator === undefined) continue;
    versions.add(rule.ruleSetVersion);
    codes.add(rule.code);
    violations.push(...evaluator(rule, context, data));
  }

  return {
    violations: violations.sort(bySeverityThenMessage),
    appliedRuleSetVersions: [...versions].sort(),
    evaluatedRuleCodes: [...codes].sort(),
  };
}

const SEVERITY_ORDER: Record<Severity, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

function bySeverityThenMessage(a: Violation, b: Violation): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  return bySeverity !== 0 ? bySeverity : a.message.localeCompare(b.message);
}

/**
 * 확정(commit)을 막아야 하는 위반이 있는가.
 *
 * BLOCK 위반이 있어도 사유를 입력하면 진행할 수 있어야 한다. 무조건 막으면
 * 사용자가 시스템 밖에서 일하게 되고, 그러면 기록 자체가 사라진다.
 * (docs/02-domain-rules.md §7.2)
 */
export function hasBlockingViolations(violations: readonly Violation[]): boolean {
  return violations.some((v) => v.severity === 'BLOCK');
}

export function summarizeViolations(
  violations: readonly Violation[],
): Record<Severity, number> {
  return violations.reduce<Record<Severity, number>>(
    (acc, v) => {
      acc[v.severity] += 1;
      return acc;
    },
    { BLOCK: 0, WARN: 0, INFO: 0 },
  );
}
