"""자연어 해석 결과의 검증·반영.

LLM 호출 자체(`parse_constraints`)는 여기서 테스트하지 않는다 — API 키가
없기도 하고, 무엇보다 **테스트해야 할 대상이 아니다.** LLM은 언제든 이상한
값을 뱉을 수 있다는 전제로 만들었으므로, 확인해야 할 것은 "이상한 값이
들어왔을 때 근무표에 영향을 주지 못하는가"다.
"""

from __future__ import annotations

from datetime import date

from mediwork_ai.nl import (
    CONFIDENCE_THRESHOLD,
    ParsedConstraint,
    apply_constraints,
    validate_parsed,
)

from .fixtures import PERIOD_START, ward


def _c(**kwargs: object) -> ParsedConstraint:
    base = {"type": "PREFERRED_OFF", "confidence": 1.0}
    base.update(kwargs)
    return ParsedConstraint.model_validate(base)


class TestValidation:
    def test_명단에_없는_이름은_버린다(self) -> None:
        # LLM이 사람 이름을 잘못 짚는 것이 가장 흔하고 가장 위험한 실패다.
        request = ward()
        result = validate_parsed(
            [_c(member_name="없는사람", dates=[PERIOD_START])], request
        )
        assert result.accepted == []
        assert len(result.rejected) == 1
        assert "명단에 없는" in result.rejected[0].reason

    def test_없는_근무유형을_가리키면_버린다(self) -> None:
        request = ward()
        result = validate_parsed(
            [_c(type="AVOID_SHIFT", member_name="간호사1", shift_code="X")], request
        )
        assert result.accepted == []
        assert "없는 근무유형" in result.rejected[0].reason

    def test_기간_밖의_날짜는_버린다(self) -> None:
        request = ward()
        result = validate_parsed(
            [_c(member_name="간호사1", dates=[date(2027, 1, 1)])], request
        )
        assert result.accepted == []
        assert "기간 밖" in result.rejected[0].reason

    def test_날짜가_없는_휴무_제약은_버린다(self) -> None:
        request = ward()
        result = validate_parsed([_c(member_name="간호사1", dates=[])], request)
        assert result.accepted == []

    def test_확신도가_낮으면_자동_반영하지_않고_확인을_요청한다(self) -> None:
        request = ward()
        result = validate_parsed(
            [
                _c(
                    member_name="간호사1",
                    dates=[PERIOD_START],
                    confidence=CONFIDENCE_THRESHOLD - 0.01,
                )
            ],
            request,
        )
        assert result.accepted == []
        assert len(result.needs_confirmation) == 1

    def test_UNKNOWN은_사용자에게_되묻는다(self) -> None:
        # 해석하지 못한 요청을 조용히 버리면 관리자는 반영된 줄 안다.
        request = ward()
        result = validate_parsed(
            [_c(type="UNKNOWN", confidence=0.2, source_text="셋째 주 금요일 회식")],
            request,
        )
        assert result.needs_confirmation[0].source_text == "셋째 주 금요일 회식"
        assert result.accepted == []

    def test_올바른_제약은_통과한다(self) -> None:
        request = ward()
        result = validate_parsed(
            [_c(member_name="간호사1", dates=[PERIOD_START], confidence=0.95)], request
        )
        assert len(result.accepted) == 1
        assert result.rejected == []

    def test_한_묶음에_섞여_와도_각각_분류된다(self) -> None:
        request = ward()
        result = validate_parsed(
            [
                _c(member_name="간호사1", dates=[PERIOD_START], confidence=0.95),
                _c(member_name="없는사람", dates=[PERIOD_START]),
                _c(member_name="간호사2", dates=[PERIOD_START], confidence=0.3),
            ],
            request,
        )
        assert len(result.accepted) == 1
        assert len(result.rejected) == 1
        assert len(result.needs_confirmation) == 1


class TestApply:
    def test_원본_요청을_고치지_않는다(self) -> None:
        # 사용자가 "이 해석은 빼주세요"라고 하면 처음부터 다시 조립해야 한다.
        request = ward()
        before = request.members[0].preferred_off.copy()
        apply_constraints(
            request, [_c(member_name="간호사1", dates=[PERIOD_START], confidence=1.0)]
        )
        assert request.members[0].preferred_off == before

    def test_희망휴무가_반영된다(self) -> None:
        request = ward()
        updated = apply_constraints(
            request, [_c(member_name="간호사1", dates=[PERIOD_START], confidence=1.0)]
        )
        assert PERIOD_START in updated.members[0].preferred_off

    def test_확정_휴무는_fixed로_들어간다(self) -> None:
        request = ward()
        updated = apply_constraints(
            request,
            [_c(type="FIXED_OFF", member_name="간호사1", dates=[PERIOD_START])],
        )
        assert updated.members[0].fixed[PERIOD_START] == "O"

    def test_근무_제외가_반영된다(self) -> None:
        request = ward()
        updated = apply_constraints(
            request,
            [_c(type="AVOID_SHIFT", member_name="간호사1", shift_code="N")],
        )
        assert "N" in updated.members[0].unavailable_shift_codes

    def test_같은_제약을_두_번_적용해도_중복되지_않는다(self) -> None:
        request = ward()
        constraint = _c(type="AVOID_SHIFT", member_name="간호사1", shift_code="N")
        updated = apply_constraints(request, [constraint, constraint])
        assert updated.members[0].unavailable_shift_codes.count("N") == 1

    def test_반영된_요청이_실제로_근무표에_영향을_준다(self) -> None:
        # 검증·반영이 통과해도 솔버까지 이어지지 않으면 의미가 없다.
        from mediwork_ai.solver import solve

        request = ward(member_count=14)
        updated = apply_constraints(
            request,
            [_c(type="AVOID_SHIFT", member_name="간호사1", shift_code="N")],
        )
        result = solve(updated)
        assigned = {
            (a.member_id, a.shift_code)
            for a in result.assignments
            if a.member_id == "m1"
        }
        assert ("m1", "N") not in assigned
