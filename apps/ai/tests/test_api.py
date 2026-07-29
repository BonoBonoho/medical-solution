"""HTTP 계층."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient
from mediwork_ai.main import app
from mediwork_ai.models import SolveStatus

from .fixtures import ward

client = TestClient(app)


def _payload(**kwargs: object) -> dict:
    return ward(**kwargs).model_dump(mode="json")  # type: ignore[arg-type]


def test_헬스체크는_인증_없이_접근할_수_있다() -> None:
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_근무표를_생성한다() -> None:
    res = client.post("/api/v1/roster/solve", json=_payload())
    assert res.status_code == 200
    body = res.json()
    assert body["status"] in ("OPTIMAL", "FEASIBLE")
    assert len(body["assignments"]) > 0
    assert body["stats"]


def test_해가_없으면_200과_함께_충돌_내역을_돌려준다() -> None:
    # 4xx로 던지면 클라이언트가 "요청이 잘못됐다"고 해석한다. 요청은 옳고
    # 조건이 서로 모순인 것이므로 구분해야 한다.
    res = client.post("/api/v1/roster/solve", json=_payload(member_count=3))
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == SolveStatus.INFEASIBLE.value
    assert body["assignments"] == []
    assert body["conflicts"]
    assert body["conflicts"][0]["detail"]


def test_잘못된_입력은_422다() -> None:
    payload = _payload()
    payload["period_end"] = "2026-01-01"  # 시작보다 빠름
    res = client.post("/api/v1/roster/solve", json=payload)
    assert res.status_code == 422


def test_없는_근무유형을_가리키면_422다() -> None:
    payload = _payload()
    payload["members"][0]["unavailable_shift_codes"] = ["없는코드"]
    res = client.post("/api/v1/roster/solve", json=payload)
    assert res.status_code == 422


def test_문서는_기본적으로_노출되지_않는다() -> None:
    # 내부 서비스다. 스키마에 구성원 이름·휴가 필드가 그대로 드러난다.
    assert client.get("/docs").status_code == 404


def test_검증_실패는_500이며_결과를_돌려주지_않는다(monkeypatch: pytest.MonkeyPatch) -> None:
    """모델 버그로 제약을 어긴 근무표가 나오면 폐기한다.

    잘못된 근무표를 200으로 돌려주면 그대로 확정돼 근로감독까지 간다.
    """
    from mediwork_ai import solver
    from mediwork_ai.verify import VerificationError

    def _boom(*_args: object, **_kwargs: object) -> None:
        raise VerificationError(["간호사1 2026-08-04: 금지 패턴 E→D"])

    monkeypatch.setattr(solver, "verify_solution", _boom)

    res = client.post("/api/v1/roster/solve", json=_payload())
    assert res.status_code == 500
    body = res.json()
    assert body["error"]["code"] == "SOLUTION_VERIFICATION_FAILED"
    assert "assignments" not in body
    # 무엇이 어긋났는지는 남긴다. 원인 없는 500은 고칠 수 없다.
    assert body["error"]["failures"]
