"""근무표 생성 요청·응답 스키마.

타입 정의를 코어 API(TypeScript)와 맞추는 것이 아니라 **좁게** 잡았다.
AI 서비스는 근무표 생성에 필요한 것만 받는다. 인사 정보 전체를 넘기면
VPC 내부라 해도 유출 반경이 불필요하게 넓어진다.
(docs/08-ai-features.md §9.2)
"""

from __future__ import annotations

from datetime import date
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ShiftKind(str, Enum):
    """근무유형의 성격. 코드 문자열은 기관마다 다르므로 성격으로 구분한다."""

    WORK = "WORK"
    OFF = "OFF"
    LEAVE = "LEAVE"


class ShiftType(BaseModel):
    code: str = Field(min_length=1, max_length=8)
    kind: ShiftKind
    #: 이 근무 1회의 근로시간(분). OFF/LEAVE는 0.
    paid_minutes: int = Field(ge=0, le=24 * 60)
    #: 야간(22:00~06:00)이 포함되는가. 연속 야간 상한 판정에 쓴다.
    is_night: bool = False
    #: `HH:MM`. OFF/LEAVE면 None.
    start_time: str | None = None
    end_time: str | None = None

    @model_validator(mode="after")
    def _check_times(self) -> ShiftType:
        if self.kind is ShiftKind.WORK and (self.start_time is None or self.end_time is None):
            raise ValueError(f"근무유형 {self.code}: WORK는 시작·종료 시각이 필요합니다.")
        if self.kind is not ShiftKind.WORK and self.paid_minutes != 0:
            raise ValueError(f"근무유형 {self.code}: OFF/LEAVE의 근로시간은 0이어야 합니다.")
        return self


class Member(BaseModel):
    id: str
    name: str
    #: 배정 불가한 근무유형 코드. 자격 미보유·야간전담 제외 등.
    unavailable_shift_codes: list[str] = Field(default_factory=list)
    #: 반드시 이 근무여야 하는 날. 확정 휴가·교육 등. `{날짜: 근무코드}`
    fixed: dict[date, str] = Field(default_factory=dict)
    #: 희망 휴무일. 소프트 제약이다 — 못 지켜도 근무표는 나와야 한다.
    preferred_off: list[date] = Field(default_factory=list)
    #: 직전 기간 마지막 날의 근무코드. 경계 조건 판정에 쓴다.
    previous_day_shift_code: str | None = None


class Demand(BaseModel):
    """날짜·근무유형별 필요 인력."""

    work_date: date
    shift_code: str
    minimum: int = Field(ge=0)
    #: 이상 인력. 최소는 하드, 이상은 소프트로 다룬다.
    ideal: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _check_ideal(self) -> Demand:
        if self.ideal is not None and self.ideal < self.minimum:
            raise ValueError("ideal은 minimum보다 작을 수 없습니다.")
        return self


class HardConstraints(BaseModel):
    """반드시 만족해야 하는 제약.

    법정 제약과 병동 운영상 절대 조건이 섞여 있다. 어느 쪽이든 만족하지
    못하면 근무표를 내지 않는다 — "거의 맞는" 근무표는 근로감독에서
    아무 소용이 없다.
    """

    #: 금지 전이. `[["E", "D"], ["N", "E"]]` = 이브닝 다음날 데이 금지 등.
    forbidden_transitions: list[tuple[str, str]] = Field(default_factory=list)
    #: 연속 야간 상한. None이면 제한 없음.
    max_consecutive_nights: int | None = Field(default=None, ge=1)
    #: 연속 근무일 상한.
    max_consecutive_work_days: int | None = Field(default=None, ge=1)
    #: 주(월~일) 근로시간 상한(분).
    weekly_max_minutes: int | None = Field(default=None, ge=0)
    #: 주당 최소 휴무일.
    weekly_min_off_days: int | None = Field(default=None, ge=0)
    #: 근무 종료 후 다음 근무 시작까지 최소 휴식(분). 근기법 §59②의 11시간 등.
    min_rest_minutes: int | None = Field(default=None, ge=0)


class SoftWeights(BaseModel):
    """소프트 제약 가중치.

    ⚠️ 기본값은 **출발점일 뿐**이다. 중환자실과 외래는 우선순위가 완전히
    다르므로 병동별 설정값이어야 한다. 여기 숫자를 그대로 쓰면 어느 병동에도
    맞지 않는 근무표가 나온다. (docs/08-ai-features.md §2.2)
    """

    preferred_off: int = Field(default=100, ge=0)
    night_fairness: int = Field(default=80, ge=0)
    weekend_fairness: int = Field(default=60, ge=0)
    ideal_staffing: int = Field(default=40, ge=0)


class SolveRequest(BaseModel):
    period_start: date
    period_end: date
    members: list[Member] = Field(min_length=1)
    shift_types: list[ShiftType] = Field(min_length=1)
    demands: list[Demand] = Field(default_factory=list)
    hard: HardConstraints = Field(default_factory=HardConstraints)
    weights: SoftWeights = Field(default_factory=SoftWeights)
    #: 탐색 시간 상한(초). 간호사 스케줄링은 NP-hard라 최적해를 기다릴 수 없다.
    time_limit_seconds: float = Field(default=30.0, gt=0, le=300)
    #: 재현 가능한 결과가 필요할 때 고정한다(테스트·회귀 확인).
    random_seed: int | None = None

    @model_validator(mode="after")
    def _check(self) -> SolveRequest:
        if self.period_end < self.period_start:
            raise ValueError("period_end는 period_start보다 빠를 수 없습니다.")
        if (self.period_end - self.period_start).days > 92:
            raise ValueError("한 번에 생성할 수 있는 기간은 최대 93일입니다.")

        codes = [s.code for s in self.shift_types]
        if len(codes) != len(set(codes)):
            raise ValueError("근무유형 코드가 중복되었습니다.")
        known = set(codes)

        # 알 수 없는 코드를 조용히 무시하면 "왜 반영이 안 됐지"를 디버깅하게 된다.
        for demand in self.demands:
            if demand.shift_code not in known:
                raise ValueError(f"demand가 없는 근무유형을 가리킵니다: {demand.shift_code}")
        for member in self.members:
            for code in member.unavailable_shift_codes:
                if code not in known:
                    raise ValueError(f"{member.name}: 없는 근무유형 {code}")
            for day, code in member.fixed.items():
                if code not in known:
                    raise ValueError(f"{member.name} {day}: 없는 근무유형 {code}")
        for a, b in self.hard.forbidden_transitions:
            if a not in known or b not in known:
                raise ValueError(f"금지 패턴이 없는 근무유형을 가리킵니다: {a}→{b}")

        member_ids = [m.id for m in self.members]
        if len(member_ids) != len(set(member_ids)):
            raise ValueError("구성원 id가 중복되었습니다.")
        return self


class Assignment(BaseModel):
    member_id: str
    work_date: date
    shift_code: str


class UnmetRequest(BaseModel):
    """반영하지 못한 소프트 제약.

    "3건은 반영했고 1건은 이래서 못 했다"를 말할 수 있어야 관리자가
    결과를 신뢰한다. 조용히 무시하면 다음 달부터 시스템 밖에서 일한다.
    """

    member_id: str
    work_date: date
    kind: Literal["PREFERRED_OFF"]
    reason: str


class SolveStatus(str, Enum):
    OPTIMAL = "OPTIMAL"
    FEASIBLE = "FEASIBLE"
    INFEASIBLE = "INFEASIBLE"
    UNKNOWN = "UNKNOWN"


class Conflict(BaseModel):
    """해가 없을 때 어떤 제약이 원인인지."""

    constraint: str
    detail: str


class SolveResponse(BaseModel):
    status: SolveStatus
    assignments: list[Assignment] = Field(default_factory=list)
    unmet: list[UnmetRequest] = Field(default_factory=list)
    conflicts: list[Conflict] = Field(default_factory=list)
    #: 목적함수 값. 해가 없으면 None.
    objective: int | None = None
    wall_time_seconds: float = 0.0
    #: 사람별 야간 횟수 등, 관리자가 공정성을 눈으로 확인할 지표.
    stats: dict[str, dict[str, int]] = Field(default_factory=dict)
