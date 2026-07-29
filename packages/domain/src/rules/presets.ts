/**
 * 시스템 기본 제공 규칙 세트.
 *
 * ⚖️ 여기의 수치와 조문은 설계 참고용이다. 실제 운영 전 공인노무사 검증이
 * 필수이며, 법령 개정 시 새 버전을 추가해야 한다(기존 버전은 수정하지 않는다).
 */

import type { RuleSet } from './types.js';

/** 5인 이상 사업장의 일반 근로자 기본 규칙. */
export const KR_GENERAL_2026: RuleSet = {
  id: 'kr-general-2026.1',
  name: '대한민국 일반 근로자 (5인 이상)',
  version: 'kr-general-2026.1',
  scope: {},
  effectiveFrom: '2026-01-01',
  priority: 0,
  isActive: true,
  rules: [
    {
      code: 'WEEKLY_MAX_MINUTES',
      params: { limitMinutes: 3120 }, // 40h + 12h
      severity: 'BLOCK',
      legalBasis: '근로기준법 제50조·제53조',
      enabled: true,
    },
    {
      code: 'WEEKLY_HOLIDAY_MIN',
      params: { minDays: 1 },
      severity: 'WARN',
      legalBasis: '근로기준법 제55조 제1항',
      enabled: true,
    },
    {
      code: 'BREAK_TIME_MIN',
      params: {},
      severity: 'WARN',
      legalBasis: '근로기준법 제54조',
      enabled: true,
    },
    {
      code: 'MAX_CONSECUTIVE_WORK_DAYS',
      params: { maxDays: 6 },
      severity: 'WARN',
      enabled: true,
    },
  ],
};

/**
 * 보건업 근로시간 특례 적용 사업장.
 *
 * 근기법 제59조에 따라 근로자대표와 서면 합의하면 주 12시간 초과 연장근로가
 * 가능하다. 다만 2018년 개정으로 근무 종료 후 **연속 11시간 휴식**을 보장해야
 * 한다(같은 조 제2항). 특례는 "시간 한도"의 예외이지 "가산수당"의 예외가 아니다.
 *
 * ⚠️ 이 규칙 세트는 유효한 서면합의(labor_agreement)가 있을 때만 적용해야 한다.
 * 합의가 만료되면 자동으로 비활성화되어 52시간 규칙이 되살아나야 한다.
 */
export const KR_HEALTHCARE_EXCEPTION_2026: RuleSet = {
  id: 'kr-healthcare-exception-2026.1',
  name: '보건업 근로시간 특례 (서면합의 필요)',
  version: 'kr-healthcare-exception-2026.1',
  scope: {},
  effectiveFrom: '2026-01-01',
  priority: 100,
  isActive: true,
  rules: [
    {
      // 특례 적용 시 주간 상한 규칙을 끈다.
      code: 'WEEKLY_MAX_MINUTES',
      params: {},
      severity: 'INFO',
      legalBasis: '근로기준법 제59조 제1항',
      enabled: false,
    },
    {
      code: 'MIN_REST_BETWEEN_SHIFTS',
      params: { minMinutes: 660 }, // 11시간
      severity: 'BLOCK',
      legalBasis: '근로기준법 제59조 제2항',
      enabled: true,
    },
  ],
};

/**
 * 3교대 간호 인력 권장 규칙.
 *
 * 법정 규칙은 아니지만 실무상 강하게 권장된다. 특히 E→D(퀵 리턴)는 가장 흔한
 * 위반이자 간호사 피로도·이직의 주요 원인이므로 기본값으로 금지한다.
 */
export const KR_NURSING_SHIFT_2026: RuleSet = {
  id: 'kr-nursing-shift-2026.1',
  name: '3교대 간호 인력 권장 규칙',
  version: 'kr-nursing-shift-2026.1',
  scope: { jobFamily: 'NURSE' },
  effectiveFrom: '2026-01-01',
  priority: 50,
  isActive: true,
  rules: [
    {
      code: 'FORBIDDEN_SHIFT_PATTERN',
      instanceKey: 'E-D',
      params: { pattern: ['E', 'D'] },
      severity: 'BLOCK',
      enabled: true,
    },
    {
      code: 'FORBIDDEN_SHIFT_PATTERN',
      instanceKey: 'N-E',
      params: { pattern: ['N', 'E'] },
      severity: 'BLOCK',
      enabled: true,
    },
    {
      code: 'MAX_CONSECUTIVE_NIGHTS',
      params: { maxNights: 3 },
      severity: 'WARN',
      enabled: true,
    },
  ],
};

/**
 * 전공의 수련시간 규칙 — **값 미확정 템플릿**.
 *
 * ⚠️ 전공의법의 구체적 시간 수치는 개정 논의가 활발한 영역이다. 임의의 수치를
 * 넣어두면 그대로 출시될 위험이 있어 의도적으로 비워둔다.
 * 시행 중인 전공의법 및 시행규칙 조문을 직접 확인해 값을 확정한 뒤
 * 새 RuleSet 버전으로 등록할 것. (docs/02-domain-rules.md §3.2)
 */
export const KR_RESIDENT_TEMPLATE: RuleSet = {
  id: 'kr-resident-template',
  name: '전공의 수련시간 (값 확정 필요)',
  version: 'kr-resident-template',
  scope: { jobFamily: 'RESIDENT' },
  effectiveFrom: '9999-12-31', // 값 확정 전에는 적용되지 않도록 미래 날짜
  priority: 200,
  isActive: false,
  rules: [
    {
      code: 'WEEKLY_MAX_MINUTES',
      params: {}, // limitMinutes 미확정
      severity: 'BLOCK',
      legalBasis: '전공의의 수련환경 개선 및 지위 향상을 위한 법률',
      enabled: false,
    },
  ],
};

export const DEFAULT_RULE_SETS: readonly RuleSet[] = [
  KR_GENERAL_2026,
  KR_NURSING_SHIFT_2026,
];

/** 특례 서면합의가 유효한 사업장용 규칙 세트 구성. */
export function ruleSetsWithHealthcareException(
  worksiteId: string,
  agreementEffectiveFrom: string,
  agreementEffectiveTo: string,
): RuleSet[] {
  return [
    ...DEFAULT_RULE_SETS,
    {
      ...KR_HEALTHCARE_EXCEPTION_2026,
      id: `${KR_HEALTHCARE_EXCEPTION_2026.id}:${worksiteId}`,
      scope: { worksiteId },
      effectiveFrom: agreementEffectiveFrom,
      effectiveTo: agreementEffectiveTo,
    },
  ];
}
