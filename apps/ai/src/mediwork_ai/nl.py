"""자연어 요청 → 구조화 제약.

수간호사는 "김수진 간호사 9월엔 나이트 빼주세요, 신규 2명은 프리셉터랑 같은
듀티로 묶어주세요" 같은 문장으로 요청한다. 이걸 사람이 매번 폼에 옮기게
하면 AI를 쓰는 의미가 없다.

**설계에서 중요한 것은 LLM이 아니라 LLM 뒤의 검증이다.**

LLM은 사람 이름을 잘못 짚거나, 없는 근무유형을 만들어내거나, 요청에 없는
제약을 추가할 수 있다. 그 결과가 그대로 하드 제약이 되면 근무표가 조용히
틀어진다. 그래서 이 모듈은 세 겹으로 되어 있다.

  1. `parse_constraints()` — LLM 호출. 스키마를 강제한다.
  2. `validate_parsed()`   — 결정론적 검증. 존재하지 않는 사람·근무유형·날짜를
                             가리키면 버린다. **여기가 실제 방어선이다.**
  3. `apply_constraints()` — 검증을 통과한 것만 SolveRequest에 반영한다.

2·3번은 LLM 없이 동작하며 테스트로 고정되어 있다. LLM이 무엇을 뱉든
이 두 단계를 통과하지 못하면 근무표에 영향을 줄 수 없다.

⚠️ 1번(실제 API 호출)은 이 저장소에서 **검증되지 않았다.** API 키가 없어
호출해 본 적이 없다. 형태만 맞춰 두었으니 키를 넣고 반드시 확인할 것.
"""

from __future__ import annotations

import json
import os
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

from .models import Member, SolveRequest

#: 근무표 제약 해석에 쓰는 모델.
MODEL = "claude-opus-5"


class ParsedConstraint(BaseModel):
    """LLM이 뱉는 구조. 여기 있는 값은 **아직 신뢰할 수 없다.**"""

    type: Literal[
        "AVOID_SHIFT",  # 특정인의 특정 근무 제외
        "FIXED_OFF",  # 특정인의 특정일 휴무 확정
        "PREFERRED_OFF",  # 특정인의 특정일 희망휴무 (소프트)
        "UNKNOWN",  # 해석 실패. 사용자에게 되묻는다
    ]
    member_name: str | None = None
    shift_code: str | None = None
    dates: list[date] = Field(default_factory=list)
    #: 0.0~1.0. 낮으면 자동 반영하지 않고 사용자에게 확인을 요청한다.
    confidence: float = Field(ge=0.0, le=1.0)
    #: 원문의 어느 부분에서 나온 해석인지. 사용자가 검토할 때 필요하다.
    source_text: str = ""


class RejectedConstraint(BaseModel):
    constraint: ParsedConstraint
    reason: str


class ValidationResult(BaseModel):
    accepted: list[ParsedConstraint] = Field(default_factory=list)
    #: 확신도가 낮아 사용자 확인이 필요한 것.
    needs_confirmation: list[ParsedConstraint] = Field(default_factory=list)
    #: 검증에 걸려 버린 것. 왜 버렸는지 함께 남긴다.
    rejected: list[RejectedConstraint] = Field(default_factory=list)


#: 이 값 미만이면 자동 반영하지 않는다. 사람 이름을 잘못 짚은 제약이
#: 조용히 근무표에 들어가는 것이 가장 나쁜 실패다.
CONFIDENCE_THRESHOLD = 0.8


SYSTEM_PROMPT = """당신은 병원 근무표 작성 시스템의 요청 해석기입니다.
수간호사가 자연어로 쓴 요청을 구조화된 제약으로 변환합니다.

규칙:
- 요청에 명시되지 않은 제약을 만들어내지 마십시오.
- 사람 이름은 주어진 명단에 있는 것만 사용하십시오. 명단에 없으면 UNKNOWN입니다.
- 근무유형 코드는 주어진 목록에 있는 것만 사용하십시오.
- 확신이 없으면 confidence를 낮게 주십시오. 추측해서 높은 값을 주지 마십시오.
- "빼주세요"는 AVOID_SHIFT, "쉬게 해주세요"는 기간이 확정이면 FIXED_OFF,
  희망 사항이면 PREFERRED_OFF입니다. 구분이 모호하면 PREFERRED_OFF를
  택하십시오 — 휴무를 강제로 확정하면 근무표가 못 나올 수 있습니다.
"""


def build_user_prompt(
    text: str, members: list[Member], shift_codes: list[str], period: tuple[date, date]
) -> str:
    names = ", ".join(m.name for m in members)
    return (
        f"기간: {period[0]} ~ {period[1]}\n"
        f"명단: {names}\n"
        f"근무유형: {', '.join(shift_codes)}\n\n"
        f"요청:\n{text}"
    )


def parse_constraints(
    text: str,
    members: list[Member],
    shift_codes: list[str],
    period: tuple[date, date],
) -> list[ParsedConstraint]:
    """LLM으로 자연어를 구조화한다.

    ⚠️ **이 함수는 실제 API에 대해 검증되지 않았다.** 키가 없어 호출해 본 적이
    없다. 사용 전 반드시 실제 응답으로 확인할 것.

    호출에 실패하면 예외를 던진다. 조용히 빈 목록을 돌려주면 "요청이 하나도
    반영되지 않았는데 아무 말도 없는" 상태가 된다.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY가 없습니다. 자연어 요청 없이 구조화 제약만으로 "
            "근무표를 생성할 수 있습니다."
        )

    try:
        import anthropic
    except ImportError as error:  # pragma: no cover - 선택 의존성
        raise RuntimeError(
            "anthropic 패키지가 설치되지 않았습니다. `pip install -e '.[nl]'`"
        ) from error

    client = anthropic.Anthropic(api_key=api_key)
    schema = {
        "type": "object",
        "properties": {
            "constraints": {
                "type": "array",
                "items": ParsedConstraint.model_json_schema(),
            }
        },
        "required": ["constraints"],
    }

    response = client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        tools=[
            {
                "name": "emit_constraints",
                "description": "해석한 제약 목록을 제출합니다.",
                "input_schema": schema,
            }
        ],
        tool_choice={"type": "tool", "name": "emit_constraints"},
        messages=[
            {
                "role": "user",
                "content": build_user_prompt(text, members, shift_codes, period),
            }
        ],
    )

    for block in response.content:
        if getattr(block, "type", None) == "tool_use":
            payload = block.input
            if isinstance(payload, str):
                payload = json.loads(payload)
            return [ParsedConstraint.model_validate(c) for c in payload["constraints"]]

    raise RuntimeError("모델이 제약을 제출하지 않았습니다.")


def validate_parsed(
    parsed: list[ParsedConstraint], request: SolveRequest
) -> ValidationResult:
    """해석 결과를 결정론적으로 검증한다.

    **여기가 실제 방어선이다.** LLM이 무엇을 뱉든 이 검사를 통과하지 못하면
    근무표에 영향을 주지 못한다.
    """
    names = {m.name: m for m in request.members}
    codes = {s.code for s in request.shift_types}
    days = {
        request.period_start.toordinal() + i
        for i in range((request.period_end - request.period_start).days + 1)
    }

    result = ValidationResult()

    for constraint in parsed:
        if constraint.type == "UNKNOWN":
            result.needs_confirmation.append(constraint)
            continue

        if constraint.member_name not in names:
            result.rejected.append(
                RejectedConstraint(
                    constraint=constraint,
                    reason=f"명단에 없는 이름입니다: {constraint.member_name}",
                )
            )
            continue

        if constraint.type == "AVOID_SHIFT":
            if constraint.shift_code not in codes:
                result.rejected.append(
                    RejectedConstraint(
                        constraint=constraint,
                        reason=f"없는 근무유형입니다: {constraint.shift_code}",
                    )
                )
                continue
        else:
            if not constraint.dates:
                result.rejected.append(
                    RejectedConstraint(constraint=constraint, reason="날짜가 없습니다.")
                )
                continue
            outside = [d for d in constraint.dates if d.toordinal() not in days]
            if outside:
                result.rejected.append(
                    RejectedConstraint(
                        constraint=constraint,
                        reason=f"기간 밖의 날짜입니다: {outside[0]}",
                    )
                )
                continue

        if constraint.confidence < CONFIDENCE_THRESHOLD:
            result.needs_confirmation.append(constraint)
        else:
            result.accepted.append(constraint)

    return result


def apply_constraints(
    request: SolveRequest, accepted: list[ParsedConstraint]
) -> SolveRequest:
    """검증을 통과한 제약을 요청에 반영한 **새 요청**을 만든다.

    원본을 고치지 않는 이유는, 사용자가 "이 해석은 빼주세요"라고 했을 때
    처음부터 다시 조립할 수 있어야 하기 때문이다.
    """
    updated = request.model_copy(deep=True)
    by_name = {m.name: m for m in updated.members}

    for constraint in accepted:
        member = by_name.get(constraint.member_name or "")
        if member is None:  # validate_parsed를 통과했다면 도달하지 않는다
            continue

        if constraint.type == "AVOID_SHIFT" and constraint.shift_code is not None:
            if constraint.shift_code not in member.unavailable_shift_codes:
                member.unavailable_shift_codes.append(constraint.shift_code)

        elif constraint.type == "FIXED_OFF":
            off_code = next(
                (s.code for s in updated.shift_types if s.kind.value == "OFF"), None
            )
            if off_code is not None:
                for day in constraint.dates:
                    member.fixed[day] = off_code

        elif constraint.type == "PREFERRED_OFF":
            for day in constraint.dates:
                if day not in member.preferred_off:
                    member.preferred_off.append(day)

    return updated


__all__ = [
    "CONFIDENCE_THRESHOLD",
    "ParsedConstraint",
    "ValidationResult",
    "apply_constraints",
    "parse_constraints",
    "validate_parsed",
]
