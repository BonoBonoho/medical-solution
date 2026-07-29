"""근무표 생성.

확인하는 것은 "그럴듯한 근무표가 나오는가"가 아니라 **하드 제약이 실제로
지켜지는가**다. 법정 제약을 어긴 근무표는 아무리 보기 좋아도 쓸모가 없다.
"""

from __future__ import annotations

from datetime import date

import pytest
from mediwork_ai.models import (
    Assignment,
    Demand,
    HardConstraints,
    Member,
    ShiftKind,
    ShiftType,
    SolveRequest,
    SolveStatus,
)
from mediwork_ai.solver import solve
from mediwork_ai.verify import VerificationError, verify_solution

from .fixtures import PERIOD_END, PERIOD_START, SHIFT_TYPES, days, ward


def _grid(result) -> dict[tuple[str, date], str]:
    return {(a.member_id, a.work_date): a.shift_code for a in result.assignments}


class TestBasicSolve:
    def test_모든_사람의_모든_날에_근무가_하나씩_배정된다(self) -> None:
        request = ward()
        result = solve(request)

        assert result.status in (SolveStatus.OPTIMAL, SolveStatus.FEASIBLE)
        assert len(result.assignments) == len(request.members) * len(days())

        grid = _grid(result)
        for member in request.members:
            for day in days():
                assert (member.id, day) in grid

    def test_최소_인력이_모든_날_모든_근무에서_채워진다(self) -> None:
        request = ward(minimum=2)
        result = solve(request)

        counts: dict[tuple[date, str], int] = {}
        for a in result.assignments:
            counts[a.work_date, a.shift_code] = counts.get((a.work_date, a.shift_code), 0) + 1

        for day in days():
            for code in ("D", "E", "N"):
                assert counts.get((day, code), 0) >= 2, f"{day} {code} 인력 부족"

    def test_같은_시드로_두_번_풀면_같은_근무표가_나온다(self) -> None:
        # 재현 불가능한 생성기는 "어제 만든 근무표가 왜 다르지"를 설명할 수 없다.
        first = solve(ward())
        second = solve(ward())
        assert _grid(first) == _grid(second)


class TestHardConstraints:
    def test_금지_패턴이_한_번도_나타나지_않는다(self) -> None:
        request = ward()
        result = solve(request)
        grid = _grid(result)

        for member in request.members:
            for a, b in zip(days(), days()[1:]):
                pair = (grid[member.id, a], grid[member.id, b])
                assert pair != ("E", "D"), f"{member.name} {b}: E→D"
                assert pair != ("N", "E"), f"{member.name} {b}: N→E"

    def test_연속_야간이_상한을_넘지_않는다(self) -> None:
        request = ward()
        result = solve(request)
        grid = _grid(result)

        for member in request.members:
            run = 0
            for day in days():
                run = run + 1 if grid[member.id, day] == "N" else 0
                assert run <= 3, f"{member.name} {day}: 연속 야간 {run}회"

    def test_연속_근무일이_상한을_넘지_않는다(self) -> None:
        request = ward()
        result = solve(request)
        grid = _grid(result)

        for member in request.members:
            run = 0
            for day in days():
                run = run + 1 if grid[member.id, day] != "O" else 0
                assert run <= 5, f"{member.name} {day}: 연속 근무 {run}일"

    def test_11시간_연속휴식이_지켜진다(self) -> None:
        # E(~23:00) 다음날 D(07:00)는 8시간뿐이다. 660분 제약이 있으면 나올 수 없다.
        request = ward()
        result = solve(request)
        grid = _grid(result)

        for member in request.members:
            for a, b in zip(days(), days()[1:]):
                assert (grid[member.id, a], grid[member.id, b]) != ("E", "D")
                assert (grid[member.id, a], grid[member.id, b]) != ("N", "D")

    def test_주당_최소_휴무일이_보장된다(self) -> None:
        request = ward()
        result = solve(request)
        grid = _grid(result)

        for member in request.members:
            for week_start in (PERIOD_START, date(2026, 8, 10)):
                week = [d for d in days() if 0 <= (d - week_start).days < 7]
                offs = sum(1 for d in week if grid[member.id, d] == "O")
                assert offs >= 1, f"{member.name} {week_start} 주: 휴무 없음"

    def test_직전월_마지막_근무가_경계에서_지켜진다(self) -> None:
        # 8/2에 이브닝이었으면 8/3 데이는 금지다. 월이 바뀌었다고 규칙이
        # 사라지지 않는다 — 실무에서 가장 자주 놓치는 지점이다.
        #
        # 전원에게 걸면 8/3 데이를 설 사람이 없어져 INFEASIBLE이 된다.
        # 그것도 올바른 동작이지만, 여기서 보려는 것은 경계 제약이 실제로
        # 배정을 막는가이므로 절반에게만 건다.
        request = ward(member_count=12)
        constrained = request.members[:6]
        for member in constrained:
            member.previous_day_shift_code = "E"

        result = solve(request)
        assert result.status in (SolveStatus.OPTIMAL, SolveStatus.FEASIBLE)
        grid = _grid(result)
        for member in constrained:
            assert grid[member.id, PERIOD_START] != "D", f"{member.name}: 경계 E→D"

    def test_직전월_경계로_해가_없어지면_그렇게_말한다(self) -> None:
        # 전원이 직전일 이브닝이면 8/3 데이 최소 인력을 채울 수 없다.
        # 이때 조용히 E→D를 만들어내는 것이 최악이다.
        request = ward(member_count=12)
        for member in request.members:
            member.previous_day_shift_code = "E"

        result = solve(request)
        assert result.status is SolveStatus.INFEASIBLE
        assert result.conflicts

    def test_배정_불가_근무는_한_번도_배정되지_않는다(self) -> None:
        request = ward()
        request.members[0].unavailable_shift_codes = ["N"]
        result = solve(request)
        grid = _grid(result)

        for day in days():
            assert grid[request.members[0].id, day] != "N"

    def test_확정_휴가는_반드시_지켜진다(self) -> None:
        request = ward()
        fixed_days = [date(2026, 8, 5), date(2026, 8, 6), date(2026, 8, 7)]
        request.members[0].fixed = {d: "O" for d in fixed_days}

        result = solve(request)
        grid = _grid(result)
        for day in fixed_days:
            assert grid[request.members[0].id, day] == "O"


class TestSoftConstraints:
    def test_희망휴무가_가능한_한_반영된다(self) -> None:
        request = ward(member_count=14)
        wanted = [date(2026, 8, 5), date(2026, 8, 12)]
        request.members[0].preferred_off = wanted

        result = solve(request)
        grid = _grid(result)
        granted = sum(1 for d in wanted if grid[request.members[0].id, d] == "O")
        assert granted == len(wanted)

    def test_반영하지_못한_희망휴무는_이름과_날짜로_보고된다(self) -> None:
        # 인원을 최소 인력에 딱 맞춰 희망휴무를 들어줄 여유를 없앤다.
        # 6명 × 하루 1근무, D/E/N 각 2명 필요 = 전원이 매일 근무해야 한다.
        request = ward(member_count=6, minimum=2)
        request.hard = HardConstraints()  # 다른 제약을 빼 INFEASIBLE이 아니게 한다
        target = date(2026, 8, 5)
        request.members[0].preferred_off = [target]

        result = solve(request)
        assert result.status in (SolveStatus.OPTIMAL, SolveStatus.FEASIBLE)
        assert len(result.unmet) == 1
        assert result.unmet[0].member_id == request.members[0].id
        assert result.unmet[0].work_date == target
        # 이유가 사람이 읽을 수 있어야 한다. "UNMET"만 있으면 아무 소용이 없다.
        assert "간호사1" in result.unmet[0].reason

    def test_야간이_특정인에게_몰리지_않는다(self) -> None:
        request = ward(member_count=12)
        result = solve(request)
        nights = [row["nights"] for row in result.stats.values()]
        # 완전 균등을 요구하지 않는다. 제약을 만족하면서 균등까지 완벽히 되기는
        # 어렵고, 목적함수가 편차를 줄이는 방향으로 작동하는지만 확인한다.
        assert max(nights) - min(nights) <= 2, f"야간 편차 과다: {sorted(nights)}"

    def test_통계에_사람별_지표가_모두_들어간다(self) -> None:
        request = ward()
        result = solve(request)
        assert set(result.stats) == {m.id for m in request.members}
        for row in result.stats.values():
            assert row["work_days"] + row["off_days"] == len(days())


class TestInfeasible:
    def test_인력이_모자라면_해가_없다고_말한다(self) -> None:
        # 3명으로 D/E/N 각 2명(하루 6명)은 불가능하다.
        request = ward(member_count=3, minimum=2)
        result = solve(request)
        assert result.status is SolveStatus.INFEASIBLE
        assert result.assignments == []

    def test_해가_없으면_무엇이_충돌하는지_말한다(self) -> None:
        # "INFEASIBLE"만 던지면 관리자는 무엇을 고쳐야 할지 알 수 없다.
        request = ward(member_count=3, minimum=2)
        result = solve(request)
        assert result.conflicts, "충돌 진단이 비어 있다"
        assert all(c.detail for c in result.conflicts)

    def test_최소_인력이_원인이면_그것을_지목한다(self) -> None:
        request = ward(member_count=4, minimum=2)
        result = solve(request)
        assert result.status is SolveStatus.INFEASIBLE
        names = {c.constraint for c in result.conflicts}
        assert "demand" in names or "MULTIPLE" in names

    def test_해가_없어도_예외를_던지지_않는다(self) -> None:
        # 조건이 모순인 것은 사용자 잘못도 서버 오류도 아니다. 결과로 다룬다.
        result = solve(ward(member_count=2, minimum=2))
        assert result.status is SolveStatus.INFEASIBLE


class TestVerification:
    """솔버를 믿지 않고 다시 확인하는 계층 자체의 테스트."""

    def test_올바른_해는_통과한다(self) -> None:
        request = ward()
        result = solve(request)
        verify_solution(request, result.assignments)  # 예외가 없어야 한다

    def test_금지_패턴을_어긴_해를_잡아낸다(self) -> None:
        request = ward(member_count=12)
        result = solve(request)
        tampered = list(result.assignments)

        # 첫 사람의 이틀을 E→D로 강제로 바꾼다.
        target = request.members[0].id
        a, b = days()[0], days()[1]
        tampered = [
            x for x in tampered if not (x.member_id == target and x.work_date in (a, b))
        ]
        tampered.append(Assignment(member_id=target, work_date=a, shift_code="E"))
        tampered.append(Assignment(member_id=target, work_date=b, shift_code="D"))

        with pytest.raises(VerificationError) as excinfo:
            verify_solution(request, tampered)
        assert any("E→D" in f for f in excinfo.value.failures)

    def test_최소_인력_미달을_잡아낸다(self) -> None:
        request = ward()
        result = solve(request)
        # 첫날 D 근무자를 전부 O로 바꾼다.
        first = days()[0]
        tampered = [
            Assignment(member_id=a.member_id, work_date=a.work_date, shift_code="O")
            if (a.work_date == first and a.shift_code == "D")
            else a
            for a in result.assignments
        ]
        with pytest.raises(VerificationError):
            verify_solution(request, tampered)

    def test_배정_누락을_잡아낸다(self) -> None:
        request = ward()
        result = solve(request)
        with pytest.raises(VerificationError):
            verify_solution(request, result.assignments[:-1])


class TestValidation:
    def test_기간이_뒤집히면_거부한다(self) -> None:
        with pytest.raises(ValueError, match="period_end"):
            SolveRequest(
                period_start=PERIOD_END,
                period_end=PERIOD_START,
                members=[Member(id="m1", name="a")],
                shift_types=SHIFT_TYPES,
            )

    def test_없는_근무유형을_가리키면_거부한다(self) -> None:
        # 조용히 무시하면 "왜 반영이 안 됐지"를 디버깅하게 된다.
        with pytest.raises(ValueError, match="없는 근무유형"):
            SolveRequest(
                period_start=PERIOD_START,
                period_end=PERIOD_END,
                members=[Member(id="m1", name="a", unavailable_shift_codes=["X"])],
                shift_types=SHIFT_TYPES,
            )

    def test_demand가_없는_근무유형을_가리키면_거부한다(self) -> None:
        with pytest.raises(ValueError, match="demand"):
            SolveRequest(
                period_start=PERIOD_START,
                period_end=PERIOD_END,
                members=[Member(id="m1", name="a")],
                shift_types=SHIFT_TYPES,
                demands=[Demand(work_date=PERIOD_START, shift_code="X", minimum=1)],
            )

    def test_구성원_id_중복을_거부한다(self) -> None:
        with pytest.raises(ValueError, match="중복"):
            SolveRequest(
                period_start=PERIOD_START,
                period_end=PERIOD_END,
                members=[Member(id="m1", name="a"), Member(id="m1", name="b")],
                shift_types=SHIFT_TYPES,
            )

    def test_OFF에_근로시간을_넣으면_거부한다(self) -> None:
        with pytest.raises(ValueError, match="근로시간은 0"):
            ShiftType(code="O", kind=ShiftKind.OFF, paid_minutes=480)

    def test_기간이_너무_길면_거부한다(self) -> None:
        # 무제한을 허용하면 타임박스 안에 아무 해도 못 찾고 UNKNOWN만 나온다.
        with pytest.raises(ValueError, match="93일"):
            SolveRequest(
                period_start=date(2026, 1, 1),
                period_end=date(2026, 12, 31),
                members=[Member(id="m1", name="a")],
                shift_types=SHIFT_TYPES,
            )
