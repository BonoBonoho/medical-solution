# syntax=docker/dockerfile:1

# 코어 API.
#
# 모노레포라서 빌드 컨텍스트가 저장소 루트다. `docker build -f apps/api/Dockerfile .`
# 워크스페이스 의존(@mediwork/domain)을 함께 빌드해야 하기 때문이다.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# -- 의존성 -------------------------------------------------------------------
# 매니페스트만 먼저 복사해 소스가 바뀌어도 install 레이어를 재사용한다.

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# -- 빌드 ---------------------------------------------------------------------

FROM deps AS build
COPY packages/domain packages/domain
COPY apps/api apps/api
RUN pnpm --filter @mediwork/domain build && pnpm --filter @mediwork/api build

# 운영 의존만 남긴다. devDependencies에는 vitest·typescript가 들어 있고
# 이미지에 있을 이유가 없다.
RUN pnpm --filter @mediwork/api --prod deploy --legacy /out && \
    cp -r apps/api/dist /out/dist

# -- 실행 ---------------------------------------------------------------------

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV TZ=Asia/Seoul

# root로 돌리지 않는다. 컨테이너가 뚫렸을 때 할 수 있는 일을 줄인다.
RUN addgroup -g 1000 -S app && adduser -u 1000 -S app -G app
WORKDIR /app

COPY --from=build --chown=app:app /out /app

USER app
EXPOSE 3000

# tini 없이 node를 PID 1로 둔다. Node 22는 SIGTERM을 직접 처리하고,
# ECS의 stopTimeout 안에 진행 중인 요청을 마무리한다.
CMD ["node", "dist/main.js"]
