import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * API 오류 코드. docs/05-api-design.md §1.4 와 일치시킨다.
 *
 * message는 사용자에게 그대로 보여줄 수 있는 한국어여야 한다.
 * 별도 번역 레이어를 두지 않는다.
 */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'DEVICE_NOT_BOUND'
  | 'FORBIDDEN'
  | 'INTEGRITY_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RULE_VIOLATION'
  | 'LOCATION_UNVERIFIED'
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'AI_UNAVAILABLE';

const STATUS_BY_CODE: Record<ApiErrorCode, HttpStatus> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  DEVICE_NOT_BOUND: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  INTEGRITY_FAILED: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  RULE_VIOLATION: HttpStatus.CONFLICT,
  LOCATION_UNVERIFIED: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_BALANCE: HttpStatus.UNPROCESSABLE_ENTITY,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  AI_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
};

export interface ApiErrorOptions {
  readonly details?: readonly unknown[];
  /**
   * 오류이면서도 데이터를 함께 돌려줘야 하는 경우.
   *
   * 위치 검증 실패(422)가 대표적이다. 앱은 "기록되었으나 승인 대기"를 정확히
   * 표시해야 하며, 실패로만 처리하면 직원이 재시도를 반복하다 결국 출근 기록이
   * 없는 상태가 된다. (docs/05-api-design.md §2)
   */
  readonly data?: unknown;
}

export class ApiError extends HttpException {
  readonly code: ApiErrorCode;
  private readonly apiOptions: ApiErrorOptions;

  constructor(code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(
      {
        error: {
          code,
          message,
          ...(options.details !== undefined ? { details: options.details } : {}),
        },
        ...(options.data !== undefined ? { data: options.data } : {}),
      },
      STATUS_BY_CODE[code],
    );
    this.code = code;
    this.apiOptions = options;
  }

  get data(): unknown {
    return this.apiOptions.data;
  }
}
