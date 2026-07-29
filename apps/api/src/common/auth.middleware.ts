import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ApiError } from './errors.js';
import { runWithContext, type RequestContext } from './tenant-context.js';

/**
 * 인증 미들웨어.
 *
 * ⚠️ 개발용 구현이다. 운영에서는 서명 검증된 JWT를 해석해야 한다.
 * 토큰 형식: `dev <tenantId>:<memberId>:<role1,role2>[:<deviceId>]`
 *
 * 중요한 것은 형식이 아니라 원칙이다 — 테넌트는 **토큰에서만** 결정되며,
 * 클라이언트가 보낸 tenantId 파라미터는 절대 신뢰하지 않는다.
 */
@Injectable()
export class AuthMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('authorization');
    if (header === undefined || !header.startsWith('dev ')) {
      throw new ApiError('UNAUTHENTICATED', '인증 정보가 없거나 형식이 올바르지 않습니다.');
    }

    const [tenantId, memberId, roles = '', deviceId] = header.slice(4).split(':');
    if (
      tenantId === undefined ||
      tenantId === '' ||
      memberId === undefined ||
      memberId === ''
    ) {
      throw new ApiError('UNAUTHENTICATED', '토큰에서 테넌트 또는 사용자를 확인할 수 없습니다.');
    }

    const requestId = randomUUID();
    const context: RequestContext = {
      tenantId,
      memberId,
      roles: roles === '' ? ['MEMBER'] : roles.split(','),
      departmentScope: [],
      ...(deviceId !== undefined && deviceId !== '' ? { deviceId } : {}),
      requestId,
    };

    res.setHeader('x-request-id', requestId);
    runWithContext(context, () => {
      next();
    });
  }
}
