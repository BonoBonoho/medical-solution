# syntax=docker/dockerfile:1

# AI 서비스. 빌드 컨텍스트는 apps/ai 하나면 된다 —
# 워크스페이스 의존이 없다.

FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

FROM base AS deps
WORKDIR /app
COPY pyproject.toml ./
COPY src src
RUN pip install --prefix=/install .

FROM base AS runtime
ENV TZ=Asia/Seoul
RUN useradd --uid 1000 --create-home --shell /usr/sbin/nologin app
WORKDIR /app

COPY --from=deps /install /usr/local
COPY --from=deps --chown=app:app /app/src /app/src

USER app
EXPOSE 3002

# 워커를 여러 개 두지 않는다. CP-SAT가 이미 여러 스레드를 쓰므로
# 프로세스를 늘리면 CPU를 서로 뺏는다. 처리량은 태스크 수로 늘린다.
CMD ["python", "-m", "uvicorn", "mediwork_ai.main:app", \
     "--host", "0.0.0.0", "--port", "3002", "--app-dir", "src", "--workers", "1"]
