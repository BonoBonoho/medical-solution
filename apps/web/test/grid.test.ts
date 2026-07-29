/**
 * 그리드 로직.
 *
 * 여기서 확인하는 것은 "위반이 올바른 칸에 칠해지는가"다. 이게 틀리면
 * 화면에는 아무 표시가 없는데 확정은 막히는, 사용자가 원인을 알 수 없는
 * 상태가 된다.
 */

import { describe, expect, it } from 'vitest';
import type { RosterPlan } from '@mediwork/domain';
import {
  buildGridModel,
  cellKey,
  datesInPeriod,
  violationsByCell,
  withCellChanged,
} from '../src/lib/grid.js';
import { SAMPLE_PLAN, SHIFT_TYPE_ID_BY_CODE } from '../src/lib/sample.js';

const D = SHIFT_TYPE_ID_BY_CODE.get('D')!;
const N = SHIFT_TYPE_ID_BY_CODE.get('N')!;
const O = SHIFT_TYPE_ID_BY_CODE.get('O')!;

describe('datesInPeriod', () => {
  it('시작일과 종료일을 포함한다', () => {
    expect(datesInPeriod('2026-08-03', '2026-08-06')).toEqual([
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
    ]);
  });

  it('월을 넘어가도 이어진다', () => {
    expect(datesInPeriod('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
  });
});

describe('withCellChanged', () => {
  it('셀을 바꿔도 원본 plan은 그대로다 — undo를 나중에 얹을 수 있다', () => {
    const before = SAMPLE_PLAN.assignments.length;
    const next = withCellChanged(SAMPLE_PLAN, 'm1', '2026-08-05', O);
    expect(SAMPLE_PLAN.assignments).toHaveLength(before);
    expect(next.assignments).toHaveLength(before);
    expect(next).not.toBe(SAMPLE_PLAN);
  });

  it('한 셀에 배정은 하나만 남는다', () => {
    const next = withCellChanged(SAMPLE_PLAN, 'm1', '2026-08-05', N);
    const forCell = next.assignments.filter(
      (a) => a.memberId === 'm1' && a.workDate === '2026-08-05',
    );
    expect(forCell).toHaveLength(1);
    expect(forCell[0]!.shiftTypeId).toBe(N);
  });

  it('null이면 배정을 지운다', () => {
    const next = withCellChanged(SAMPLE_PLAN, 'm1', '2026-08-05', null);
    expect(
      next.assignments.some((a) => a.memberId === 'm1' && a.workDate === '2026-08-05'),
    ).toBe(false);
  });

  it('기존 배정의 id를 유지한다 — 서버가 수정으로 인식해야 한다', () => {
    const original = SAMPLE_PLAN.assignments.find(
      (a) => a.memberId === 'm1' && a.workDate === '2026-08-05',
    )!;
    const next = withCellChanged(SAMPLE_PLAN, 'm1', '2026-08-05', N);
    const changed = next.assignments.find(
      (a) => a.memberId === 'm1' && a.workDate === '2026-08-05',
    )!;
    expect(changed.id).toBe(original.id);
  });

  it('빈 칸을 채우면 draft id를 붙인다 — 서버가 신규로 구분한다', () => {
    const cleared = withCellChanged(SAMPLE_PLAN, 'm1', '2026-08-05', null);
    const filled = withCellChanged(cleared, 'm1', '2026-08-05', D);
    const created = filled.assignments.find(
      (a) => a.memberId === 'm1' && a.workDate === '2026-08-05',
    )!;
    expect(created.id.startsWith('draft:')).toBe(true);
  });
});

describe('violationsByCell', () => {
  const dates = datesInPeriod('2026-08-03', '2026-08-09');

  it('shiftAssignment 위반은 해당 배정이 있는 칸에 붙는다', () => {
    const assignments = [
      { id: 'a1', memberId: 'm1', workDate: '2026-08-04' as const, shiftTypeId: D },
    ];
    const map = violationsByCell(
      [
        {
          ruleCode: 'FORBIDDEN_SHIFT_PATTERN',
          severity: 'BLOCK',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '금지 패턴',
          subjects: [{ type: 'shiftAssignment', id: 'a1' }],
          detail: {},
        },
      ],
      assignments,
      dates,
    );
    expect(map.get(cellKey('m1', '2026-08-04'))?.severity).toBe('BLOCK');
    expect(map.has(cellKey('m1', '2026-08-05'))).toBe(false);
  });

  it('week 위반은 그 주 전체에 칠해진다 — 어느 줄이 문제인지 보여야 한다', () => {
    const map = violationsByCell(
      [
        {
          ruleCode: 'WEEKLY_MAX_MINUTES',
          severity: 'BLOCK',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '주 52시간 초과',
          subjects: [{ type: 'week', id: 'm1|2026-08-03' }],
          detail: {},
        },
      ],
      [],
      dates,
    );
    // 2026-08-03(월)부터 08-09(일)까지가 한 주다.
    for (const date of dates) {
      expect(map.get(cellKey('m1', date))?.severity).toBe('BLOCK');
    }
    expect(map.has(cellKey('m2', '2026-08-03'))).toBe(false);
  });

  it('day 위반은 그 날 칸에만 붙는다', () => {
    const map = violationsByCell(
      [
        {
          ruleCode: 'BREAK_TIME_MIN',
          severity: 'WARN',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '휴게시간 부족',
          subjects: [{ type: 'day', id: 'm1|2026-08-06' }],
          detail: {},
        },
      ],
      [],
      dates,
    );
    expect(map.get(cellKey('m1', '2026-08-06'))?.severity).toBe('WARN');
    expect(map.size).toBe(1);
  });

  it('한 칸에 여러 위반이 겹치면 가장 심각한 것으로 칠한다', () => {
    const assignments = [
      { id: 'a1', memberId: 'm1', workDate: '2026-08-04' as const, shiftTypeId: D },
    ];
    const map = violationsByCell(
      [
        {
          ruleCode: 'BREAK_TIME_MIN',
          severity: 'WARN',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '휴게 부족',
          subjects: [{ type: 'day', id: 'm1|2026-08-04' }],
          detail: {},
        },
        {
          ruleCode: 'FORBIDDEN_SHIFT_PATTERN',
          severity: 'BLOCK',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '금지 패턴',
          subjects: [{ type: 'shiftAssignment', id: 'a1' }],
          detail: {},
        },
      ],
      assignments,
      dates,
    );
    const cell = map.get(cellKey('m1', '2026-08-04'))!;
    expect(cell.severity).toBe('BLOCK');
    expect(cell.direct).toHaveLength(2);
  });

  it('없는 배정을 가리키는 위반은 조용히 버린다 — 편집 중 흔한 중간 상태', () => {
    const map = violationsByCell(
      [
        {
          ruleCode: 'FORBIDDEN_SHIFT_PATTERN',
          severity: 'BLOCK',
          basis: 'PLANNED',
          memberId: 'm1',
          message: '금지 패턴',
          subjects: [{ type: 'shiftAssignment', id: '없는id' }],
          detail: {},
        },
      ],
      [],
      dates,
    );
    expect(map.size).toBe(0);
  });
});

describe('buildGridModel', () => {
  it('샘플 근무표에는 주석이 말한 그대로의 위반이 들어 있다', () => {
    // 샘플이 조용히 "깨끗한" 근무표가 되면 그리드가 위반을 못 그려도
    // 아무도 모른다. 데이터가 주장하는 바를 여기서 고정한다.
    const model = buildGridModel(SAMPLE_PLAN);
    const codes = new Set(model.evaluation.violations.map((v) => v.ruleCode));
    expect(codes).toContain('FORBIDDEN_SHIFT_PATTERN'); // E→D 퀵리턴
    expect(codes).toContain('MIN_REST_BETWEEN_SHIFTS'); // 11시간 연속휴식
    expect(codes).toContain('MAX_CONSECUTIVE_NIGHTS'); // 나이트 4연속
    expect(
      model.evaluation.violations.some((v) => v.severity === 'BLOCK'),
    ).toBe(true);
    expect(model.cellViolations.size).toBeGreaterThan(0);
  });

  it('특례 사업장이라 주 52시간 규칙 대신 연속휴식 규칙이 걸린다', () => {
    const model = buildGridModel(SAMPLE_PLAN);
    expect(model.evaluation.appliedRuleSetVersions).toContain(
      'kr-healthcare-exception-2026.1',
    );
    expect(model.evaluation.violations.map((v) => v.ruleCode)).not.toContain(
      'WEEKLY_MAX_MINUTES',
    );
  });

  it('칸을 오프로 바꾸면 위반이 줄어든다 — 편집이 즉시 반영된다', () => {
    const before = buildGridModel(SAMPLE_PLAN);
    const worst = before.evaluation.violations.find((v) => v.severity === 'BLOCK');
    expect(worst).toBeDefined();

    // 위반이 걸린 사람의 모든 근무를 오프로 바꾸면 그 사람의 위반은 사라진다.
    let plan: RosterPlan = SAMPLE_PLAN;
    for (const date of before.dates) {
      plan = withCellChanged(plan, worst!.memberId, date, O);
    }
    const after = buildGridModel(plan);

    const countFor = (m: ReturnType<typeof buildGridModel>): number =>
      m.evaluation.violations.filter(
        (v) => v.memberId === worst!.memberId && v.severity === 'BLOCK',
      ).length;

    expect(countFor(after)).toBeLessThan(countFor(before));
  });

  it('모든 배정이 셀 색인에 들어간다', () => {
    const model = buildGridModel(SAMPLE_PLAN);
    expect(model.cells.size).toBe(SAMPLE_PLAN.assignments.length);
  });

  it('주별 집계는 사람마다 주 시작일 순서로 정렬된다', () => {
    const model = buildGridModel(SAMPLE_PLAN);
    for (const weeks of model.weeklyByMember.values()) {
      const sorted = [...weeks].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
      expect(weeks.map((w) => w.weekStart)).toEqual(sorted.map((w) => w.weekStart));
    }
  });
});
