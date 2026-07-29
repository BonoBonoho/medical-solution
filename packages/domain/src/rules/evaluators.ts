/** 개별 규칙 평가기. 전부 부수효과 없는 순수 함수다. */

import { gapMinutes } from '../time/interval.js';
import type {
  EvaluatedShift,
  RuleCode,
  RuleContext,
  RuleDefinition,
  RuleEvaluationData,
  RuleEvaluator,
  Violation,
} from './types.js';

function num(params: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strArray(params: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = params[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function formatHours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

function formatDate(date: string): string {
  const [, month, day] = date.split('-') as [string, string, string];
  return `${Number(month)}/${Number(day)}`;
}

function workingShiftsSorted(data: RuleEvaluationData, memberId: string): EvaluatedShift[] {
  return data.shifts
    .filter((s) => s.memberId === memberId && s.isWorking && s.interval !== null)
    .sort((a, b) => a.interval!.start.getTime() - b.interval!.start.getTime());
}

/** 주간 총 근로시간 상한. 근기법 제50조·제53조 (기본 40 + 12 = 52시간). */
const weeklyMaxMinutes: RuleEvaluator = (rule, context, data) => {
  const limit = num(rule.params, 'limitMinutes', 3120);
  const violations: Violation[] = [];

  for (const week of data.weeklies) {
    if (week.memberId !== context.member.id) continue;
    if (week.totalMinutes <= limit) continue;

    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: week.memberId,
      message:
        `${context.member.name} — ${week.weekStart} 주 근로시간 ${formatHours(week.totalMinutes)}` +
        ` (상한 ${formatHours(limit)}, ${formatHours(week.totalMinutes - limit)} 초과)`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: [{ type: 'week', id: `${week.memberId}|${week.weekStart}` }],
      suggestion: `해당 주의 근무 ${Math.ceil((week.totalMinutes - limit) / 60)}시간을 줄이거나 다른 주로 재배치하면 해소됩니다.`,
      detail: {
        weekStart: week.weekStart,
        totalMinutes: week.totalMinutes,
        limitMinutes: limit,
        excessMinutes: week.totalMinutes - limit,
      },
    });
  }
  return violations;
};

/**
 * 시프트 간 최소 연속휴식. 근기법 제59조 제2항(특례 적용 시 11시간).
 *
 * 실무에서 가장 흔한 위반이 E→D(퀵 리턴)다. 단순 뺄셈이 아니라 실제 종료·시작
 * 시각으로 계산해야 한다. (docs/02-domain-rules.md §2.4)
 */
const minRestBetweenShifts: RuleEvaluator = (rule, context, data) => {
  const minMinutes = num(rule.params, 'minMinutes', 660);
  const shifts = workingShiftsSorted(data, context.member.id);
  const violations: Violation[] = [];

  for (let i = 0; i + 1 < shifts.length; i++) {
    const earlier = shifts[i]!;
    const later = shifts[i + 1]!;
    const gap = gapMinutes(earlier.interval!, later.interval!);
    if (gap >= minMinutes) continue;

    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: context.member.id,
      message:
        `${context.member.name} — ${formatDate(earlier.workDate)} ${earlier.shiftName} 종료 후` +
        ` ${formatDate(later.workDate)} ${later.shiftName} 시작까지 휴식 ${formatHours(Math.max(0, gap))}` +
        ` (최소 ${formatHours(minMinutes)})`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: [
        { type: 'shiftAssignment', id: earlier.id },
        { type: 'shiftAssignment', id: later.id },
      ],
      suggestion: `${formatDate(later.workDate)} 근무를 오프로 변경하거나 시작 시각을 늦추면 해소됩니다.`,
      detail: {
        earlierDate: earlier.workDate,
        earlierShift: earlier.shiftCode,
        laterDate: later.workDate,
        laterShift: later.shiftCode,
        restMinutes: gap,
        minMinutes,
      },
    });
  }
  return violations;
};

/** 금지된 근무 패턴. 예: `["E", "D"]` = 이브닝 다음날 데이. */
const forbiddenShiftPattern: RuleEvaluator = (rule, context, data) => {
  const pattern = strArray(rule.params, 'pattern');
  if (pattern.length < 2) return [];

  const shifts = data.shifts
    .filter((s) => s.memberId === context.member.id)
    .sort((a, b) => a.workDate.localeCompare(b.workDate));

  const violations: Violation[] = [];
  for (let i = 0; i + pattern.length <= shifts.length; i++) {
    const window = shifts.slice(i, i + pattern.length);
    const consecutive = window.every(
      (s, idx) => idx === 0 || isNextDay(window[idx - 1]!.workDate, s.workDate),
    );
    if (!consecutive) continue;
    if (!window.every((s, idx) => s.shiftCode === pattern[idx])) continue;

    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: context.member.id,
      message:
        `${context.member.name} — ${formatDate(window[0]!.workDate)}부터 금지 패턴 ` +
        `${pattern.join('→')} 이 배정되어 있습니다.`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: window.map((s) => ({ type: 'shiftAssignment' as const, id: s.id })),
      suggestion: `${formatDate(window[window.length - 1]!.workDate)} 근무를 다른 유형으로 변경하면 해소됩니다.`,
      detail: {
        pattern,
        startDate: window[0]!.workDate,
        dates: window.map((s) => s.workDate),
      },
    });
  }
  return violations;
};

/** 연속 야간근무 상한. */
const maxConsecutiveNights: RuleEvaluator = (rule, context, data) => {
  const max = num(rule.params, 'maxNights', 3);
  const shifts = data.shifts
    .filter((s) => s.memberId === context.member.id)
    .sort((a, b) => a.workDate.localeCompare(b.workDate));

  const violations: Violation[] = [];
  let run: EvaluatedShift[] = [];

  const flush = (): void => {
    if (run.length <= max) {
      run = [];
      return;
    }
    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: context.member.id,
      message:
        `${context.member.name} — ${formatDate(run[0]!.workDate)}부터 야간근무 ${run.length}일 연속` +
        ` (상한 ${max}일)`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: run.map((s) => ({ type: 'shiftAssignment' as const, id: s.id })),
      suggestion: `${formatDate(run[max]!.workDate)} 이후 야간근무 사이에 오프를 배치하면 해소됩니다.`,
      detail: {
        startDate: run[0]!.workDate,
        consecutiveNights: run.length,
        maxNights: max,
      },
    });
    run = [];
  };

  for (const shift of shifts) {
    const continues =
      run.length === 0 || isNextDay(run[run.length - 1]!.workDate, shift.workDate);
    if (shift.isNight && shift.isWorking) {
      if (!continues) flush();
      run.push(shift);
    } else {
      flush();
    }
  }
  flush();
  return violations;
};

/** 연속 근무일 상한. */
const maxConsecutiveWorkDays: RuleEvaluator = (rule, context, data) => {
  const max = num(rule.params, 'maxDays', 6);
  const shifts = data.shifts
    .filter((s) => s.memberId === context.member.id)
    .sort((a, b) => a.workDate.localeCompare(b.workDate));

  const violations: Violation[] = [];
  let run: EvaluatedShift[] = [];

  const flush = (): void => {
    if (run.length <= max) {
      run = [];
      return;
    }
    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: context.member.id,
      message:
        `${context.member.name} — ${formatDate(run[0]!.workDate)}부터 ${run.length}일 연속 근무` +
        ` (상한 ${max}일)`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: run.map((s) => ({ type: 'shiftAssignment' as const, id: s.id })),
      suggestion: `연속 구간 중 하루를 오프로 변경하면 해소됩니다.`,
      detail: { startDate: run[0]!.workDate, consecutiveDays: run.length, maxDays: max },
    });
    run = [];
  };

  for (const shift of shifts) {
    const continues =
      run.length === 0 || isNextDay(run[run.length - 1]!.workDate, shift.workDate);
    if (shift.isWorking) {
      if (!continues) flush();
      run.push(shift);
    } else {
      flush();
    }
  }
  flush();
  return violations;
};

/** 주휴일 최소 일수. 근기법 제55조 제1항. */
const weeklyHolidayMin: RuleEvaluator = (rule, context, data) => {
  const minDays = num(rule.params, 'minDays', 1);
  const violations: Violation[] = [];

  for (const week of data.weeklies) {
    if (week.memberId !== context.member.id) continue;
    // 주 전체가 데이터에 포함된 경우에만 판정한다. 월 경계에서 오탐을 막는다.
    if (week.offDays >= minDays) continue;

    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: week.memberId,
      message:
        `${context.member.name} — ${week.weekStart} 주 휴무일이 ${week.offDays}일입니다` +
        ` (최소 ${minDays}일)`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: [{ type: 'week', id: `${week.memberId}|${week.weekStart}` }],
      suggestion: '해당 주에 휴무일을 추가 배치하면 해소됩니다.',
      detail: { weekStart: week.weekStart, offDays: week.offDays, minDays },
    });
  }
  return violations;
};

/** 법정 휴게시간. 근기법 제54조. */
const breakTimeMin: RuleEvaluator = (rule, context, data) => {
  const violations: Violation[] = [];

  for (const daily of data.dailies) {
    if (daily.memberId !== context.member.id) continue;
    const worked = daily.paidMinutes + daily.breakMinutes;
    const required = worked >= 480 ? 60 : worked >= 240 ? 30 : 0;
    if (required === 0 || daily.breakMinutes >= required) continue;

    violations.push({
      ruleCode: rule.code,
      severity: rule.severity,
      basis: context.basis,
      memberId: daily.memberId,
      message:
        `${context.member.name} — ${formatDate(daily.workDate)} 근무 ${formatHours(worked)}에 대해` +
        ` 휴게 ${daily.breakMinutes}분 (최소 ${required}분)`,
      ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
      subjects: [{ type: 'day', id: `${daily.memberId}|${daily.workDate}` }],
      suggestion: `휴게시간을 ${required}분 이상으로 조정하면 해소됩니다.`,
      detail: {
        workDate: daily.workDate,
        workedMinutes: worked,
        breakMinutes: daily.breakMinutes,
        requiredMinutes: required,
      },
    });
  }
  return violations;
};

function isNextDay(a: string, b: string): boolean {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return tb - ta === 86_400_000;
}

export const EVALUATORS: Readonly<Record<RuleCode, RuleEvaluator>> = {
  WEEKLY_MAX_MINUTES: weeklyMaxMinutes,
  MIN_REST_BETWEEN_SHIFTS: minRestBetweenShifts,
  FORBIDDEN_SHIFT_PATTERN: forbiddenShiftPattern,
  MAX_CONSECUTIVE_NIGHTS: maxConsecutiveNights,
  MAX_CONSECUTIVE_WORK_DAYS: maxConsecutiveWorkDays,
  WEEKLY_HOLIDAY_MIN: weeklyHolidayMin,
  BREAK_TIME_MIN: breakTimeMin,
};

export type { RuleContext, RuleDefinition, RuleEvaluationData, Violation };
