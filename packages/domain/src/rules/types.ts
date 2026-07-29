/**
 * 규칙 엔진 타입.
 *
 * 핵심 설계: 규칙은 코드가 아니라 **시행일을 가진 버전화된 데이터**다.
 * 법령이 개정되면 새 RuleSet을 추가하고, 과거 기간은 당시 규칙으로 재계산한다.
 * (docs/02-domain-rules.md §1)
 */

import type { Interval, LocalDate } from '../time/interval.js';

export type JobFamily =
  | 'DOCTOR'
  | 'RESIDENT'
  | 'NURSE'
  | 'NURSE_AIDE'
  | 'MED_TECH'
  | 'PHARMACIST'
  | 'ADMIN'
  | 'FACILITY';

export type EmploymentType =
  | 'REGULAR'
  | 'CONTRACT'
  | 'PART_TIME'
  | 'TEMPORARY'
  | 'CONTRACT_PROF';

export type Severity = 'BLOCK' | 'WARN' | 'INFO';

/** 계획(근무표) 기준인지 실적(출퇴근 기록) 기준인지. 반드시 분리해 평가한다. */
export type EvaluationBasis = 'PLANNED' | 'ACTUAL';

export type RuleCode =
  | 'WEEKLY_MAX_MINUTES'
  | 'MIN_REST_BETWEEN_SHIFTS'
  | 'FORBIDDEN_SHIFT_PATTERN'
  | 'MAX_CONSECUTIVE_NIGHTS'
  | 'MAX_CONSECUTIVE_WORK_DAYS'
  | 'WEEKLY_HOLIDAY_MIN'
  | 'BREAK_TIME_MIN';

export interface RuleDefinition {
  readonly code: RuleCode;
  /**
   * 같은 코드의 규칙을 여러 개 둘 때의 식별자.
   *
   * 금지 패턴처럼 한 코드에 여러 인스턴스가 필요한 규칙이 있다
   * (E→D 금지와 N→E 금지는 둘 다 FORBIDDEN_SHIFT_PATTERN이다).
   * 코드만으로 덮어쓰기를 판정하면 뒤에 온 규칙이 앞의 것을 지워버린다.
   * 상위 우선순위 규칙 세트가 특정 인스턴스만 끄려면 같은 키를 쓰면 된다.
   */
  readonly instanceKey?: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly severity: Severity;
  /** UI에 근거를 표시하기 위한 조문. 예: "근로기준법 제59조 제2항" */
  readonly legalBasis?: string;
  readonly enabled: boolean;
}

export interface RuleScope {
  readonly worksiteId?: string;
  readonly jobFamily?: JobFamily;
  readonly employmentType?: EmploymentType;
}

export interface RuleSet {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly scope: RuleScope;
  readonly effectiveFrom: LocalDate;
  readonly effectiveTo?: LocalDate;
  /** 좁은 스코프가 넓은 스코프를 덮어쓴다. 큰 값이 우선. */
  readonly priority: number;
  readonly isActive: boolean;
  readonly rules: readonly RuleDefinition[];
}

export interface RuleMember {
  readonly id: string;
  readonly name: string;
  readonly worksiteId: string;
  readonly jobFamily: JobFamily;
  readonly employmentType: EmploymentType;
}

export interface RuleContext {
  readonly member: RuleMember;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly basis: EvaluationBasis;
  readonly offsetMinutes?: number;
}

export interface EntityRef {
  readonly type: 'shiftAssignment' | 'attendanceRecord' | 'week' | 'day';
  readonly id: string;
}

export interface Violation {
  readonly ruleCode: RuleCode;
  readonly severity: Severity;
  readonly basis: EvaluationBasis;
  readonly memberId: string;
  /**
   * 사용자에게 그대로 보여줄 한국어 메시지.
   * "규칙 위반"만 뜨는 시스템은 아무도 쓰지 않는다. 무엇이 왜 문제인지 말한다.
   */
  readonly message: string;
  readonly legalBasis?: string;
  readonly subjects: readonly EntityRef[];
  /** 어떻게 하면 해소되는지. 가능하면 항상 채운다. */
  readonly suggestion?: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** 규칙 평가의 입력 데이터. */
export interface RuleEvaluationData {
  /** 근무 배정. workDate 오름차순으로 정렬되어 있다고 가정하지 않는다. */
  readonly shifts: readonly EvaluatedShift[];
  readonly dailies: readonly EvaluatedDaily[];
  readonly weeklies: readonly EvaluatedWeek[];
}

export interface EvaluatedShift {
  readonly id: string;
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly shiftCode: string;
  readonly shiftName: string;
  /** null이면 오프·휴가. */
  readonly interval: Interval | null;
  readonly isNight: boolean;
  readonly isWorking: boolean;
}

export interface EvaluatedDaily {
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly paidMinutes: number;
  readonly breakMinutes: number;
}

export interface EvaluatedWeek {
  readonly memberId: string;
  readonly weekStart: LocalDate;
  readonly totalMinutes: number;
  readonly offDays: number;
}

export type RuleEvaluator = (
  rule: RuleDefinition,
  context: RuleContext,
  data: RuleEvaluationData,
) => Violation[];
