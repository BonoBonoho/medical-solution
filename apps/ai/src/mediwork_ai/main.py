"""AI 서비스 HTTP 진입점.

이 서비스는 VPC 내부에서만 접근 가능해야 한다. 근무표 생성 입력에는
구성원 이름과 휴가 일정이 들어 있고, 인터넷에 노출할 이유가 전혀 없다.
(docs/08-ai-features.md §9.1)
"""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from .models import SolveRequest, SolveResponse
from .solver import solve
from .verify import VerificationError

logger = logging.getLogger(__name__)

app = FastAPI(
    title="MediWork AI",
    version="0.1.0",
    description="근무표 자동 생성 (CP-SAT)",
    # 내부 서비스이므로 문서를 기본 노출하지 않는다. 필요하면 명시적으로 켠다.
    docs_url="/docs" if os.environ.get("EXPOSE_DOCS") == "1" else None,
    redoc_url=None,
)


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/roster/solve", response_model=SolveResponse)
def solve_roster(request: SolveRequest) -> SolveResponse:
    """근무표를 생성한다.

    해가 없으면 200과 함께 `status=INFEASIBLE`, 그리고 **무엇이 충돌하는지**를
    돌려준다. 4xx로 던지면 클라이언트는 "요청이 잘못됐다"고 해석하지만
    실제로는 요청이 옳고 조건이 서로 모순인 것이므로 구분해야 한다.
    """
    try:
        return solve(request)
    except VerificationError as error:
        # 하드 제약을 어긴 근무표를 돌려주느니 실패하는 편이 낫다.
        # 이건 사용자 잘못이 아니라 우리 모델의 버그다.
        logger.error("생성 결과 검증 실패: %s", error.failures)
        raise HTTPException(
            status_code=500,
            detail={
                "code": "SOLUTION_VERIFICATION_FAILED",
                "message": "생성된 근무표가 제약을 위반해 폐기했습니다. "
                "이 문제는 서버에 기록되었습니다.",
                "failures": error.failures,
            },
        ) from error


@app.exception_handler(HTTPException)
def http_exception_handler(_request: object, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(status_code=exc.status_code, content={"error": detail})
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "ERROR", "message": str(detail)}},
    )
