"""테스트용 병동 구성.

실제 3교대 병동에 가깝게 만들었다. 인원과 최소 인력을 빠듯하게 잡아야
제약이 실제로 작동하는지 확인할 수 있다.
"""

from __future__ import annotations

from datetime import date, timedelta

from mediwork_ai.models import (
    Demand,
    HardConstraints,
    Member,
    ShiftKind,
    ShiftType,
    SolveRequest,
)

SHIFT_TYPES = [
    ShiftType(
        code="D",
        kind=ShiftKind.WORK,
        paid_minutes=420,
        start_time="07:00",
        end_time="15:00",
    ),
    ShiftType(
        code="E",
        kind=ShiftKind.WORK,
        paid_minutes=420,
        start_time="15:00",
        end_time="23:00",
    ),
    ShiftType(
        code="N",
        kind=ShiftKind.WORK,
        paid_minutes=480,
        is_night=True,
        start_time="22:00",
        end_time="08:00",
    ),
    ShiftType(code="O", kind=ShiftKind.OFF, paid_minutes=0),
]

PERIOD_START = date(2026, 8, 3)  # 월요일
PERIOD_END = date(2026, 8, 16)  # 두 주 정확히


def days() -> list[date]:
    return [
        PERIOD_START + timedelta(days=i)
        for i in range((PERIOD_END - PERIOD_START).days + 1)
    ]


def ward(
    *,
    member_count: int = 12,
    minimum: int = 2,
    hard: HardConstraints | None = None,
    **overrides: object,
) -> SolveRequest:
    members = [
        Member(id=f"m{i}", name=f"간호사{i}") for i in range(1, member_count + 1)
    ]
    demands = [
        Demand(work_date=day, shift_code=code, minimum=minimum)
        for day in days()
        for code in ("D", "E", "N")
    ]
    return SolveRequest(
        period_start=PERIOD_START,
        period_end=PERIOD_END,
        members=members,
        shift_types=SHIFT_TYPES,
        demands=demands,
        hard=hard
        or HardConstraints(
            forbidden_transitions=[("E", "D"), ("N", "E")],
            max_consecutive_nights=3,
            max_consecutive_work_days=5,
            weekly_min_off_days=1,
            min_rest_minutes=660,
        ),
        time_limit_seconds=20.0,
        random_seed=42,
        **overrides,  # type: ignore[arg-type]
    )
