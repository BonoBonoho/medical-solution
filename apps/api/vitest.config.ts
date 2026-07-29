import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    /**
     * 테스트 파일을 순차 실행한다.
     *
     * rls.test.ts와 api.e2e.test.ts가 **같은 PostgreSQL 스키마**를 공유하고
     * 각자 beforeAll에서 reset()(= 스키마 재생성)을 부른다. 병렬로 돌면
     * 한쪽의 reset이 다른 쪽이 조회 중인 테이블을 지워 무작위로 깨진다.
     * 파일마다 별도 DB를 만들 수도 있지만, 스키마 하나를 운영과 동일하게
     * 쓰는 편이 검증 대상에 더 가깝다.
     */
    fileParallelism: false,
  },
});
