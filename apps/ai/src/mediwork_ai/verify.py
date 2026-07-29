"""생성된 근무표를 하드 제약에 대해 **독립적으로** 재검사한다.

CP-SAT는 자신이 부여받은 제약을 어기지 않는다. 하지만 모델을 잘못 짜는 것은
언제든 가능하다 — 슬라이딩 윈도우 범위를 하나 잘못 잡거나, 경계 조건을
빠뜨리거나, 근무유형 코드를 잘못 매핑하는 식으로.

그 결과가 "법정 제약을 어긴 근무표"라면 조용히 나가서는 안 된다. 그래서
솔버 코드와 **다른 방식으로** 같은 제약을 다시 확인한다. 솔버는 변수와
선형식으로, 여기는 배정 결과를 직접 훑는 방식으로 검사한다. 같은 실수를
두 번 하기 어렵게 만드는 것이 목적이다.

검사에 걸리면 예외를 던진다. 잘못된 근무표를 내보내느니 500을 내는 편이 낫다.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from .models import Assignment, ShiftKind, SolveRequest


class VerificationError(RuntimeError):
    """생성 결과가 하드 제약을 어겼다. 모델 구성의 버그를 뜻한다."""

    def __init__(self, failures: list[str]) -> None:
        self.failures = failures
        super().__init__(
            "생성된 근무표가 하드 제약을 위반했습니다 (모델 버그): " + "; ".join(failures)
        )


def _minutes_between(end_time: str, start_time: str, gap_days: int) -> int:
    eh, em = (int(x) for x in end_time.split(":"))
    sh, sm = (int(x) for x in start_time.split(":"))
    return gap_days * 24 * 60 + (sh * 60 + sm) - (eh * 60 + em)


def verify_solution(request: SolveRequest, assignments: list[Assignment]) -> None:
    shifts = {s.code: s for s in request.shift_types}
    failures: list[str] = []

    # 사람별 날짜 → 코드
    grid: dict[str, dict[date, str]] = defaultdict(dict)
    for a in assignments:
        if a.work_date in grid[a.member_id]:
            failures.append(f"{a.member_id} {a.work_date}: 하루에 근무가 둘 이상 배정됨")
        grid[a.member_id][a.work_date] = a.shift_code

    from .solver import date_range  # 순환 참조 회피 (검증은 솔버의 하위 모듈)

    days = date_range(request.period_start, request.period_end)
    hard = request.hard

    for member in request.members:
        row = grid.get(member.id, {})

        for day in days:
            if day not in row:
                failures.append(f"{member.name} {day}: 배정 없음")

        for code in member.unavailable_shift_codes:
            for day, assigned in row.items():
                if assigned == code:
                    failures.append(f"{member.name} {day}: 배정 불가 근무 {code}")

        for day, code in member.fixed.items():
            if day in set(days) and row.get(day) != code:
                failures.append(
                    f"{member.name} {day}: 고정 배정 {code}이 지켜지지 않음 (실제 {row.get(day)})"
                )

        # 금지 전이 — 경계(직전 기간 마지막 날) 포함
        sequence: list[tuple[date | None, str | None]] = [(None, member.previous_day_shift_code)]
        sequence += [(d, row.get(d)) for d in days]
        for (_, earlier), (later_day, later) in zip(sequence, sequence[1:]):
            if earlier is None or later is None:
                continue
            if (earlier, later) in {tuple(t) for t in hard.forbidden_transitions}:
                failures.append(f"{member.name} {later_day}: 금지 패턴 {earlier}→{later}")

            if hard.min_rest_minutes is not None:
                e, l = shifts.get(earlier), shifts.get(later)
                if (
                    e is not None
                    and l is not None
                    and e.kind is ShiftKind.WORK
                    and l.kind is ShiftKind.WORK
                    and e.end_time is not None
                    and l.start_time is not None
                    and e.start_time is not None
                ):
                    crosses = e.end_time <= e.start_time
                    rest = _minutes_between(e.end_time, l.start_time, 0 if crosses else 1)
                    if rest < hard.min_rest_minutes:
                        failures.append(
                            f"{member.name} {later_day}: 휴식 {rest}분 "
                            f"(최소 {hard.min_rest_minutes}분)"
                        )

        if hard.max_consecutive_nights is not None:
            run = 0
            for day in days:
                code = row.get(day)
                is_night = code is not None and shifts[code].is_night
                run = run + 1 if is_night else 0
                if run > hard.max_consecutive_nights:
                    failures.append(
                        f"{member.name} {day}: 연속 야간 {run}회 "
                        f"(상한 {hard.max_consecutive_nights})"
                    )
                    break

        if hard.max_consecutive_work_days is not None:
            run = 0
            for day in days:
                code = row.get(day)
                working = code is not None and shifts[code].kind is ShiftKind.WORK
                run = run + 1 if working else 0
                if run > hard.max_consecutive_work_days:
                    failures.append(
                        f"{member.name} {day}: 연속 근무 {run}일 "
                        f"(상한 {hard.max_consecutive_work_days})"
                    )
                    break

        weeks: dict[tuple[int, int], list[date]] = defaultdict(list)
        for day in days:
            iso = day.isocalendar()
            weeks[(iso.year, iso.week)].append(day)

        for week_days in weeks.values():
            # 솔버와 같은 이유로 부분 주는 건너뛴다.
            if len(week_days) < 7:
                continue
            if hard.weekly_max_minutes is not None:
                total = sum(
                    shifts[row[d]].paid_minutes for d in week_days if d in row
                )
                if total > hard.weekly_max_minutes:
                    failures.append(
                        f"{member.name} {week_days[0]} 주: {total}분 "
                        f"(상한 {hard.weekly_max_minutes}분)"
                    )
            if hard.weekly_min_off_days is not None:
                off = sum(
                    1
                    for d in week_days
                    if d in row and shifts[row[d]].kind is not ShiftKind.WORK
                )
                if off < hard.weekly_min_off_days:
                    failures.append(
                        f"{member.name} {week_days[0]} 주: 휴무 {off}일 "
                        f"(최소 {hard.weekly_min_off_days}일)"
                    )

    # 최소 인력
    staffed: dict[tuple[date, str], int] = defaultdict(int)
    for a in assignments:
        staffed[a.work_date, a.shift_code] += 1
    for demand in request.demands:
        if demand.work_date not in set(days):
            continue
        actual = staffed[demand.work_date, demand.shift_code]
        if actual < demand.minimum:
            failures.append(
                f"{demand.work_date} {demand.shift_code}: {actual}명 "
                f"(최소 {demand.minimum}명)"
            )

    if failures:
        raise VerificationError(failures)


__all__ = ["verify_solution", "VerificationError"]
