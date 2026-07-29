'use client';

/**
 * 근무표 그리드.
 *
 * 설계에서 가장 신경 쓴 것 두 가지.
 *
 * 1. **키보드만으로 끝까지 편집된다.** 수간호사는 30명 × 31칸을 한 번에
 *    채운다. 셀마다 드롭다운을 열어 클릭하면 900번 클릭해야 한다.
 *    방향키로 이동하고 D/E/N/O/V 키를 눌러 바로 입력한다.
 *
 * 2. **위반은 즉시 보인다.** 서버 왕복 없이 `evaluateRosterPlan`을 그 자리에서
 *    다시 돌린다. 서버가 확정 때 쓰는 것과 같은 함수라서 화면과 판정이
 *    갈라지지 않는다.
 */

import { useCallback, useMemo, useRef, useState, type JSX } from 'react';
import type { LocalDate, RosterPlan, Violation } from '@mediwork/domain';
import {
  buildGridModel,
  cellKey,
  formatHours,
  withCellChanged,
  type CellKey,
} from '@/lib/grid';

interface Props {
  readonly initialPlan: RosterPlan;
  readonly rosterId: string | null;
  readonly status: string;
  /** API에 연결되지 않아 샘플 데이터를 쓰는 중인지. */
  readonly usingSample: boolean;
  readonly sampleReason?: string | undefined;
}

/** 근무유형 코드 → 셀 배경. 색만으로 구분하지 않도록 글자도 함께 쓴다. */
const SHIFT_TONE: Record<string, string> = {
  D: 'shift-d',
  E: 'shift-e',
  N: 'shift-n',
  O: 'shift-o',
  V: 'shift-v',
};

const DOW_LABEL = ['월', '화', '수', '목', '금', '토', '일'];

export default function RosterGrid({
  initialPlan,
  rosterId,
  status,
  usingSample,
  sampleReason,
}: Props): JSX.Element {
  const [plan, setPlan] = useState<RosterPlan>(initialPlan);
  const [focus, setFocus] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [selected, setSelected] = useState<CellKey | null>(null);
  const [publishState, setPublishState] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // 편집할 때마다 다시 계산한다. 12명 × 28일 규모에서는 체감되지 않는다.
  // 이 비용이 문제가 되는 규모(수백 명)에서는 useDeferredValue나 워커로 옮긴다.
  const model = useMemo(() => buildGridModel(plan), [plan]);

  const codeById = useMemo(
    () => new Map(plan.shiftTypes.map((s) => [s.id, s.code])),
    [plan.shiftTypes],
  );
  const idByCode = useMemo(
    () => new Map(plan.shiftTypes.map((s) => [s.code, s.id])),
    [plan.shiftTypes],
  );

  const members = plan.members;
  const dates = model.dates;

  const setCell = useCallback(
    (memberId: string, workDate: LocalDate, code: string | null) => {
      const shiftTypeId = code === null ? null : (idByCode.get(code) ?? null);
      if (code !== null && shiftTypeId === null) return; // 없는 근무유형은 무시
      setPlan((p) => withCellChanged(p, memberId, workDate, shiftTypeId));
    },
    [idByCode],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const { row, col } = focus;
      const member = members[row];
      const date = dates[col];
      if (member === undefined || date === undefined) return;

      const move = (dr: number, dc: number): void => {
        event.preventDefault();
        const nextRow = Math.min(Math.max(row + dr, 0), members.length - 1);
        const nextCol = Math.min(Math.max(col + dc, 0), dates.length - 1);
        setFocus({ row: nextRow, col: nextCol });
        setSelected(cellKey(members[nextRow]!.id, dates[nextCol]!));
        gridRef.current
          ?.querySelector<HTMLElement>(`[data-cell="${nextRow}:${nextCol}"]`)
          ?.focus();
      };

      switch (event.key) {
        case 'ArrowUp':
          return move(-1, 0);
        case 'ArrowDown':
          return move(1, 0);
        case 'ArrowLeft':
          return move(0, -1);
        case 'ArrowRight':
          return move(0, 1);
        case 'Home':
          return move(0, -col);
        case 'End':
          return move(0, dates.length - 1 - col);
        default:
          break;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        setCell(member.id, date, null);
        return;
      }

      const key = event.key.toUpperCase();
      if (idByCode.has(key)) {
        event.preventDefault();
        setCell(member.id, date, key);
        // 입력 후 오른쪽으로 넘어간다. 한 사람의 한 달을 쭉 채우는 흐름.
        if (col < dates.length - 1) move(0, 1);
      }
    },
    [focus, members, dates, idByCode, setCell],
  );

  const selectedViolations: readonly Violation[] =
    selected === null ? [] : (model.cellViolations.get(selected)?.direct ?? []);

  const blocking = model.evaluation.violations.filter((v) => v.severity === 'BLOCK');
  const warnings = model.evaluation.violations.filter((v) => v.severity === 'WARN');

  const publish = useCallback(async () => {
    if (rosterId === null) {
      setPublishState('샘플 데이터라 확정할 수 없습니다. API를 연결하세요.');
      return;
    }
    const reasons = blocking.map((v) => ({
      ruleCode: v.ruleCode,
      reason: window.prompt(`강행 사유 (${v.ruleCode})\n\n${v.message}`) ?? '',
    }));
    if (reasons.some((r) => r.reason.trim() === '')) {
      setPublishState('사유를 입력하지 않아 확정을 취소했습니다.');
      return;
    }
    try {
      const { publishRoster } = await import('@/lib/api');
      const result = await publishRoster(rosterId, reasons);
      setPublishState(`확정되었습니다 (${result.status}).`);
    } catch (error) {
      setPublishState(error instanceof Error ? error.message : '확정에 실패했습니다.');
    }
  }, [rosterId, blocking]);

  return (
    <div className="page">
      <header className="head">
        <div>
          <h1>근무표</h1>
          <p className="muted">
            {plan.periodStart} ~ {plan.periodEnd} · {members.length}명 · 상태 {status}
          </p>
        </div>
        <div className="head-actions">
          <span className={blocking.length > 0 ? 'badge badge-block' : 'badge badge-ok'}>
            위반 {blocking.length}건 차단 · {warnings.length}건 경고
          </span>
          <button type="button" onClick={() => void publish()}>
            확정
          </button>
        </div>
      </header>

      {usingSample && (
        <p className="notice">
          API에 연결되지 않아 <strong>샘플 근무표</strong>를 표시하고 있습니다. 편집과 규칙
          평가는 실제와 동일하게 동작하지만 저장·확정은 되지 않습니다.
          {sampleReason !== undefined && <span className="muted"> ({sampleReason})</span>}
        </p>
      )}
      {publishState !== null && <p className="notice">{publishState}</p>}

      <p className="hint">
        방향키로 이동, <kbd>D</kbd> <kbd>E</kbd> <kbd>N</kbd> <kbd>O</kbd> <kbd>V</kbd> 로 입력,
        <kbd>Backspace</kbd> 로 삭제. 규칙 위반은 입력 즉시 표시됩니다.
      </p>

      <div className="grid-wrap">
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          className="grid"
          ref={gridRef}
          role="grid"
          aria-label="근무표"
          onKeyDown={onKeyDown}
          style={{ gridTemplateColumns: `10rem repeat(${dates.length}, 2.25rem) 6rem` }}
        >
          <div className="corner" role="columnheader">
            간호사
          </div>
          {dates.map((date) => {
            const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
            const label = DOW_LABEL[(dow + 6) % 7]!;
            const weekend = dow === 0 || dow === 6;
            return (
              <div
                key={date}
                role="columnheader"
                className={weekend ? 'colhead weekend' : 'colhead'}
                title={date}
              >
                <span className="daynum">{Number(date.slice(8, 10))}</span>
                <span className="dow">{label}</span>
              </div>
            );
          })}
          <div className="colhead" role="columnheader">
            주 평균
          </div>

          {members.map((member, row) => {
            const weeks = model.weeklyByMember.get(member.id) ?? [];
            const totalMinutes = weeks.reduce((sum, w) => sum + w.totalMinutes, 0);
            const nightMinutes = weeks.reduce((sum, w) => sum + w.nightMinutes, 0);
            const avgWeek = weeks.length === 0 ? 0 : Math.round(totalMinutes / weeks.length);

            return (
              <div key={member.id} style={{ display: 'contents' }} role="row">
                <div className="rowhead" role="rowheader">
                  <span className="name">{member.name}</span>
                  <span className="muted small">야간 {formatHours(nightMinutes)}</span>
                </div>

                {dates.map((date, col) => {
                  const key = cellKey(member.id, date);
                  const assignment = model.cells.get(key);
                  const code =
                    assignment === undefined
                      ? null
                      : (codeById.get(assignment.shiftTypeId) ?? '?');
                  const cv = model.cellViolations.get(key);
                  const classes = [
                    'cell',
                    code === null ? 'empty' : (SHIFT_TONE[code] ?? 'shift-other'),
                    cv?.severity === 'BLOCK' ? 'v-block' : '',
                    cv?.severity === 'WARN' ? 'v-warn' : '',
                    selected === key ? 'selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');

                  return (
                    <button
                      key={date}
                      type="button"
                      role="gridcell"
                      data-cell={`${row}:${col}`}
                      className={classes}
                      tabIndex={row === focus.row && col === focus.col ? 0 : -1}
                      aria-label={`${member.name} ${date} ${code ?? '미배정'}${
                        cv === undefined ? '' : ` 위반 ${cv.direct.length}건`
                      }`}
                      onFocus={() => {
                        setFocus({ row, col });
                        setSelected(key);
                      }}
                      onClick={() => setSelected(key)}
                    >
                      {code ?? ''}
                      {cv !== undefined && <span className="dot" aria-hidden="true" />}
                    </button>
                  );
                })}

                <div className="rowtotal" role="gridcell">
                  {formatHours(avgWeek)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <section className="panel">
        <h2>
          {selected === null
            ? '위반 전체'
            : `선택한 칸의 위반 (${selectedViolations.length}건)`}
        </h2>
        <ViolationList
          violations={selected === null ? model.evaluation.violations : selectedViolations}
          members={members}
        />
        <p className="muted small">
          적용 규칙: {model.evaluation.appliedRuleSetVersions.join(', ') || '없음'}
        </p>
      </section>
    </div>
  );
}

function ViolationList({
  violations,
  members,
}: {
  readonly violations: readonly Violation[];
  readonly members: readonly { id: string; name: string }[];
}): JSX.Element {
  if (violations.length === 0) {
    return <p className="muted">위반이 없습니다.</p>;
  }
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  return (
    <ul className="violations">
      {violations.map((v, i) => (
        <li key={`${v.ruleCode}-${v.memberId}-${i}`} className={`v v-${v.severity}`}>
          <div className="v-head">
            <span className="v-sev">{v.severity}</span>
            <span className="v-who">{nameById.get(v.memberId) ?? v.memberId}</span>
            <code>{v.ruleCode}</code>
          </div>
          <p className="v-msg">{v.message}</p>
          {v.suggestion !== undefined && <p className="v-fix">→ {v.suggestion}</p>}
          {v.legalBasis !== undefined && <p className="v-law">{v.legalBasis}</p>}
        </li>
      ))}
    </ul>
  );
}
