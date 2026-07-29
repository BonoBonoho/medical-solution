import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: true });

  /**
   * 브라우저에서 직접 호출하는 경로(근무표 확정 등)가 있어 CORS가 필요하다.
   *
   * 허용 출처는 반드시 환경변수로 받는다. `origin: true`(요청 출처를 그대로
   * 반영)로 두면 어떤 사이트에서든 인증 헤더를 붙여 호출할 수 있게 된다.
   * 기본값은 로컬 웹 개발 서버 하나뿐이다.
   */
  const origins = (process.env['CORS_ORIGINS'] ?? 'http://localhost:3001')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '');
  app.enableCors({ origin: origins, credentials: false });

  const port = Number(process.env['PORT'] ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`MediWork API listening on :${port}`);
}

void bootstrap();
