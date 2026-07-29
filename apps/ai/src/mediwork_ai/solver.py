"""CP-SAT 근무표 생성.

설계 원칙 세 가지.

1. **하드 제약은 타협하지 않는다.** 법정 제약을 소프트로 내리면 "거의 맞는"
   근무표가 나오고, 그건 근로감독에서 아무 소용이 없다. 만족할 수 없으면
   근무표를 내지 않고 무엇이 충돌하는지 말한다.

2. **못 지킨 요청은 반드시 보고한다.** 희망휴무 4건 중 1건을 못 지켰으면
   그 1건을 이름과 날짜로 말한다. 조용히 무시하면 관리자는 다음 달부터
   시스템 밖에서 일한다.

3. **결과를 다시 검증한다.** CP-SAT가 하드 제약을 어길 리는 없지만, 모델을
   **잘못 짜는** 것은 언제든 가능하다. 푼 결과를 독립적으로 재검사해
   불일치가 있으면 결과를 내보내지 않는다. (`verify.py`)
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import date, timedelta

from ortools.sat.python import cp_model

from .models import (
    Assignment,
    Conflict,
    ShiftKind,
    SolveRequest,
    SolveResponse,
    SolveStatus,
    UnmetRequest,
)
from .verify import VerificationError, verify_solution

_STATUS_MAP = {
    cp_model.OPTIMAL: SolveStatus.OPTIMAL,
    cp_model.FEASIBLE: SolveStatus.FEASIBLE,
    cp_model.INFEASIBLE: SolveStatus.INFEASIBLE,
    cp_model.MODEL_INVALID: SolveStatus.UNKNOWN,
    cp_model.UNKNOWN: SolveStatus.UNKNOWN,
}


def date_range(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range((end - start).days + 1)]


def _week_key(day: date) -> tuple[int, int]:
    """월요일 시작 주. `date.isocalendar()`의 (연도, 주차)를 쓴다."""
    iso = day.isocalendar()
    return (iso.year, iso.week)


def _minutes_between(
    end_time: str, start_time: str, gap_days: int
) -> int:
    """앞 근무 종료부터 다음 근무 시작까지의 분.

    종료가 시작보다 이르면 자정을 넘긴 것으로 본다(나이트 22:00~08:00).
    """
    eh, em = (int(x) for x in end_time.split(":"))
    sh, sm = (int(x) for x in start_time.split(":"))
    return gap_days * 24 * 60 + (sh * 60 + sm) - (eh * 60 + em)


class _Model:
    """CP-SAT 모델 한 벌. 충돌 진단에서 제약군을 빼고 다시 지을 수 있게 분리했다."""

    def __init__(self, request: SolveRequest, *, skip: str | None = None) -> None:
        self.request = request
        self.skip = skip
        self.days = date_range(request.period_start, request.period_end)
        self.shifts = {s.code: s for s in request.shift_types}
        self.model = cp_model.CpModel()
        self.x: dict[tuple[str, date, str], cp_model.IntVar] = {}
        self._build()

    # -- 편의 접근자 ---------------------------------------------------------

    def _is_work(self, code: str) -> bool:
        return self.shifts[code].kind is ShiftKind.WORK

    def _active(self, group: str) -> bool:
        return self.skip != group

    # -- 모델 구성 -----------------------------------------------------------

    def _build(self) -> None:
        req = self.request
        for member in req.members:
            for day in self.days:
                for code in self.shifts:
                    self.x[member.id, day, code] = self.model.new_bool_var(
                        f"x_{member.id}_{day}_{code}"
                    )

        self._one_shift_per_day()
        self._fixed_and_unavailable()
        if self._active("demand"):
            self._minimum_staffing()
        if self._active("transitions"):
            self._forbidden_transitions()
        if self._active("rest"):
            self._minimum_rest()
        if self._active("nights"):
            self._max_consecutive_nights()
        if self._active("work_days"):
            self._max_consecutive_work_days()
        if self._active("weekly_hours"):
            self._weekly_max_minutes()
        if self._active("weekly_off"):
            self._weekly_min_off_days()

        self._objective()

    def _one_shift_per_day(self) -> None:
        """1인 1일 1근무. 이건 어떤 진단에서도 빼지 않는다 — 뺄 수 없는 전제다."""
        for member in self.request.members:
            for day in self.days:
                self.model.add_exactly_one(
                    self.x[member.id, day, code] for code in self.shifts
                )

    def _fixed_and_unavailable(self) -> None:
        """확정 휴가와 자격 제한. 이것도 진단 대상에서 뺀다 — 입력 사실이다."""
        for member in self.request.members:
            for code in member.unavailable_shift_codes:
                for day in self.days:
                    self.model.add(self.x[member.id, day, code] == 0)
            for day, code in member.fixed.items():
                if day in set(self.days):
                    self.model.add(self.x[member.id, day, code] == 1)

    def _minimum_staffing(self) -> None:
        for demand in self.request.demands:
            if demand.work_date not in set(self.days):
                continue
            self.model.add(
                sum(
                    self.x[m.id, demand.work_date, demand.shift_code]
                    for m in self.request.members
                )
                >= demand.minimum
            )

    def _forbidden_transitions(self) -> None:
        for earlier_code, later_code in self.request.hard.forbidden_transitions:
            for member in self.request.members:
                # 직전 기간 경계. 8/31 나이트면 9/1 데이가 금지되는 경우.
                if member.previous_day_shift_code == earlier_code:
                    self.model.add(self.x[member.id, self.days[0], later_code] == 0)
                for a, b in zip(self.days, self.days[1:]):
                    self.model.add(
                        self.x[member.id, a, earlier_code]
                        + self.x[member.id, b, later_code]
                        <= 1
                    )

    def _minimum_rest(self) -> None:
        """근무 종료 후 다음 근무 시작까지의 최소 휴식.

        금지 전이 집합으로 전개한다 — 어떤 (앞근무, 뒷근무) 조합이 휴식
        기준에 미달하는지 미리 계산해 그 조합을 금지한다. 시각 변수를 두는
        것보다 모델이 훨씬 작아진다.
        """
        limit = self.request.hard.min_rest_minutes
        if limit is None:
            return

        violating: list[tuple[str, str]] = []
        for earlier in self.request.shift_types:
            if earlier.kind is not ShiftKind.WORK or earlier.end_time is None:
                continue
            for later in self.request.shift_types:
                if later.kind is not ShiftKind.WORK or later.start_time is None:
                    continue
                # 자정을 넘기는 근무는 종료가 다음날이므로 간격이 0일이다.
                crosses = earlier.end_time <= (earlier.start_time or "00:00")
                gap_days = 0 if crosses else 1
                if _minutes_between(earlier.end_time, later.start_time, gap_days) < limit:
                    violating.append((earlier.code, later.code))

        for earlier_code, later_code in violating:
            for member in self.request.members:
                if member.previous_day_shift_code == earlier_code:
                    self.model.add(self.x[member.id, self.days[0], later_code] == 0)
                for a, b in zip(self.days, self.days[1:]):
                    self.model.add(
                        self.x[member.id, a, earlier_code]
                        + self.x[member.id, b, later_code]
                        <= 1
                    )

    def _max_consecutive_nights(self) -> None:
        limit = self.request.hard.max_consecutive_nights
        if limit is None:
            return
        night_codes = [c for c, s in self.shifts.items() if s.is_night]
        if not night_codes:
            return

        for member in self.request.members:
            # 직전 기간 야간을 이어서 세려면 그날의 이력이 더 필요하다.
            # 지금은 마지막 하루만 받으므로 경계에서 최대 1일 과소 계산될 수 있다.
            # (직전 기간 전체를 받도록 API를 넓히기 전까지의 알려진 한계)
            for i in range(len(self.days) - limit):
                window = self.days[i : i + limit + 1]
                self.model.add(
                    sum(self.x[member.id, d, c] for d in window for c in night_codes)
                    <= limit
                )

    def _max_consecutive_work_days(self) -> None:
        limit = self.request.hard.max_consecutive_work_days
        if limit is None:
            return
        work_codes = [c for c in self.shifts if self._is_work(c)]

        for member in self.request.members:
            for i in range(len(self.days) - limit):
                window = self.days[i : i + limit + 1]
                self.model.add(
                    sum(self.x[member.id, d, c] for d in window for c in work_codes)
                    <= limit
                )

    def _weeks(self) -> dict[tuple[int, int], list[date]]:
        weeks: dict[tuple[int, int], list[date]] = defaultdict(list)
        for day in self.days:
            weeks[_week_key(day)].append(day)
        return weeks

    def _weekly_max_minutes(self) -> None:
        limit = self.request.hard.weekly_max_minutes
        if limit is None:
            return
        for member in self.request.members:
            for days in self._weeks().values():
                # 기간 경계에 걸린 부분 주는 상한을 적용하지 않는다.
                # 3일치만 보고 "52시간 넘지 않았다"고 말하는 것은 무의미하다.
                if len(days) < 7:
                    continue
                self.model.add(
                    sum(
                        self.shifts[c].paid_minutes * self.x[member.id, d, c]
                        for d in days
                        for c in self.shifts
                    )
                    <= limit
                )

    def _weekly_min_off_days(self) -> None:
        minimum = self.request.hard.weekly_min_off_days
        if minimum is None:
            return
        off_codes = [c for c, s in self.shifts.items() if s.kind is not ShiftKind.WORK]
        if not off_codes:
            return
        for member in self.request.members:
            for days in self._weeks().values():
                if len(days) < 7:
                    continue
                self.model.add(
                    sum(self.x[member.id, d, c] for d in days for c in off_codes)
                    >= minimum
                )

    # -- 목적함수 ------------------------------------------------------------

    def _objective(self) -> None:
        """소프트 제약의 가중합을 최소화한다(페널티 관점).

        최대화가 아니라 최소화로 쓴 이유는 "못 지킨 것의 비용"을 직접
        다루는 편이 가중치를 병동별로 조정할 때 이해하기 쉬워서다.
        """
        req = self.request
        w = req.weights
        terms: list[cp_model.LinearExpr] = []

        off_codes = [c for c, s in self.shifts.items() if s.kind is not ShiftKind.WORK]

        # 희망휴무 미반영
        if w.preferred_off > 0 and off_codes:
            for member in req.members:
                for day in member.preferred_off:
                    if day not in set(self.days):
                        continue
                    granted = sum(self.x[member.id, day, c] for c in off_codes)
                    terms.append(w.preferred_off * (1 - granted))

        # 나이트 횟수 편차 — 최대와 최소의 차이를 줄인다.
        night_codes = [c for c, s in self.shifts.items() if s.is_night]
        if w.night_fairness > 0 and night_codes and len(req.members) > 1:
            counts = []
            for member in req.members:
                count = self.model.new_int_var(0, len(self.days), f"n_{member.id}")
                self.model.add(
                    count
                    == sum(self.x[member.id, d, c] for d in self.days for c in night_codes)
                )
                counts.append(count)
            spread = self.model.new_int_var(0, len(self.days), "night_spread")
            hi = self.model.new_int_var(0, len(self.days), "night_max")
            lo = self.model.new_int_var(0, len(self.days), "night_min")
            self.model.add_max_equality(hi, counts)
            self.model.add_min_equality(lo, counts)
            self.model.add(spread == hi - lo)
            terms.append(w.night_fairness * spread)

        # 주말 근무 편차
        if w.weekend_fairness > 0 and len(req.members) > 1:
            weekend_days = [d for d in self.days if d.weekday() >= 5]
            work_codes = [c for c in self.shifts if self._is_work(c)]
            if weekend_days and work_codes:
                counts = []
                for member in req.members:
                    count = self.model.new_int_var(0, len(weekend_days), f"w_{member.id}")
                    self.model.add(
                        count
                        == sum(
                            self.x[member.id, d, c]
                            for d in weekend_days
                            for c in work_codes
                        )
                    )
                    counts.append(count)
                spread = self.model.new_int_var(0, len(weekend_days), "weekend_spread")
                hi = self.model.new_int_var(0, len(weekend_days), "weekend_max")
                lo = self.model.new_int_var(0, len(weekend_days), "weekend_min")
                self.model.add_max_equality(hi, counts)
                self.model.add_min_equality(lo, counts)
                self.model.add(spread == hi - lo)
                terms.append(w.weekend_fairness * spread)

        # 이상 인력 미달
        if w.ideal_staffing > 0:
            for demand in req.demands:
                if demand.ideal is None or demand.work_date not in set(self.days):
                    continue
                staffed = sum(
                    self.x[m.id, demand.work_date, demand.shift_code] for m in req.members
                )
                shortfall = self.model.new_int_var(
                    0, demand.ideal, f"short_{demand.work_date}_{demand.shift_code}"
                )
                self.model.add(shortfall >= demand.ideal - staffed)
                terms.append(w.ideal_staffing * shortfall)

        if terms:
            self.model.minimize(sum(terms))


#: 충돌 진단에서 하나씩 빼 볼 제약군. 순서는 "완화 가능성이 높은 것부터".
_RELAXABLE = [
    ("demand", "최소 인력"),
    ("weekly_off", "주당 최소 휴무일"),
    ("weekly_hours", "주간 근로시간 상한"),
    ("work_days", "연속 근무일 상한"),
    ("nights", "연속 야간 상한"),
    ("rest", "근무 간 최소 휴식"),
    ("transitions", "금지 근무 패턴"),
]


def _diagnose(request: SolveRequest) -> list[Conflict]:
    """해가 없을 때 어떤 제약군이 원인인지 찾는다.

    제약군을 하나씩 빼고 다시 풀어, 뺐더니 풀리는 것이 원인이다.
    "INFEASIBLE"만 던지면 관리자는 무엇을 고쳐야 할지 알 수 없다.

    빼고도 안 풀리면 여러 제약이 함께 얽힌 것이므로 그 사실을 말한다.
    """
    conflicts: list[Conflict] = []
    for group, label in _RELAXABLE:
        built = _Model(request, skip=group)
        solver = cp_model.CpSolver()
        # 진단은 빨리 끝나야 한다. 원래 요청의 1/4 또는 5초 중 작은 쪽.
        solver.parameters.max_time_in_seconds = min(5.0, request.time_limit_seconds / 4)
        solver.parameters.num_search_workers = 1
        status = solver.solve(built.model)
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            conflicts.append(
                Conflict(
                    constraint=group,
                    detail=f"{label} 제약을 빼면 근무표가 만들어집니다. "
                    f"이 제약이 다른 조건과 충돌합니다.",
                )
            )

    if not conflicts:
        conflicts.append(
            Conflict(
                constraint="MULTIPLE",
                detail="제약을 하나씩 빼봐도 해가 나오지 않습니다. "
                "여러 조건이 함께 얽혀 있거나 인력이 근본적으로 부족합니다. "
                "확정 휴가·자격 제한과 최소 인력을 함께 확인하세요.",
            )
        )
    return conflicts


def solve(request: SolveRequest) -> SolveResponse:
    started = time.monotonic()
    built = _Model(request)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = request.time_limit_seconds
    if request.random_seed is not None:
        # 재현성이 필요할 때는 워커를 1개로 줄인다. 병렬 탐색은 어느 해를
        # 먼저 찾느냐가 매번 달라져 같은 입력에도 다른 근무표가 나온다.
        solver.parameters.random_seed = request.random_seed
        solver.parameters.num_search_workers = 1
    else:
        solver.parameters.num_search_workers = 8

    status = solver.solve(built.model)
    elapsed = time.monotonic() - started
    mapped = _STATUS_MAP.get(status, SolveStatus.UNKNOWN)

    if mapped in (SolveStatus.INFEASIBLE, SolveStatus.UNKNOWN):
        return SolveResponse(
            status=mapped,
            conflicts=_diagnose(request) if mapped is SolveStatus.INFEASIBLE else [],
            wall_time_seconds=elapsed,
        )

    assignments = [
        Assignment(member_id=member.id, work_date=day, shift_code=code)
        for member in request.members
        for day in built.days
        for code in built.shifts
        if solver.value(built.x[member.id, day, code]) == 1
    ]

    # 솔버를 믿지 않고 다시 확인한다. 모델을 잘못 짜는 것은 언제든 가능하고,
    # 그 결과가 "법정 제약을 어긴 근무표"라면 조용히 나가서는 안 된다.
    verify_solution(request, assignments)

    return SolveResponse(
        status=mapped,
        assignments=assignments,
        unmet=_unmet(request, assignments, built),
        objective=int(solver.objective_value),
        wall_time_seconds=elapsed,
        stats=_stats(request, assignments, built),
    )


def _unmet(
    request: SolveRequest, assignments: list[Assignment], built: _Model
) -> list[UnmetRequest]:
    by_cell = {(a.member_id, a.work_date): a.shift_code for a in assignments}
    unmet: list[UnmetRequest] = []
    for member in request.members:
        for day in member.preferred_off:
            code = by_cell.get((member.id, day))
            if code is None:
                continue
            if built.shifts[code].kind is ShiftKind.WORK:
                unmet.append(
                    UnmetRequest(
                        member_id=member.id,
                        work_date=day,
                        kind="PREFERRED_OFF",
                        reason=f"{day} 최소 인력을 채우려면 {member.name}의 근무가 "
                        f"필요해 희망휴무를 반영하지 못했습니다 (배정: {code}).",
                    )
                )
    return unmet


def _stats(
    request: SolveRequest, assignments: list[Assignment], built: _Model
) -> dict[str, dict[str, int]]:
    """사람별 지표. 관리자가 공정성을 눈으로 확인할 수 있어야 한다."""
    stats: dict[str, dict[str, int]] = {
        m.id: {"nights": 0, "work_days": 0, "off_days": 0, "weekend_work": 0, "paid_minutes": 0}
        for m in request.members
    }
    for a in assignments:
        shift = built.shifts[a.shift_code]
        row = stats[a.member_id]
        row["paid_minutes"] += shift.paid_minutes
        if shift.is_night:
            row["nights"] += 1
        if shift.kind is ShiftKind.WORK:
            row["work_days"] += 1
            if a.work_date.weekday() >= 5:
                row["weekend_work"] += 1
        else:
            row["off_days"] += 1
    return stats


__all__ = ["solve", "date_range", "VerificationError"]
