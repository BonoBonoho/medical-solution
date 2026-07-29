import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { toLocalDate } from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext, hasRole } from '../common/tenant-context.js';
import { AttendanceService, type RecordAttendanceInput } from './attendance.service.js';
import type { AttendanceRecordType } from '../store/types.js';

const RECORD_TYPES: readonly AttendanceRecordType[] = [
  'CHECK_IN',
  'CHECK_OUT',
  'BREAK_START',
  'BREAK_END',
  'CALL_START',
  'CALL_END',
];

interface RecordBody {
  recordType?: string;
  capturedAt?: string;
  location?: RecordAttendanceInput['location'];
  device?: RecordAttendanceInput['device'];
  clientNonce?: string;
  source?: RecordAttendanceInput['source'];
}

@Controller('api/v1/attendance')
export class AttendanceController {
  constructor(@Inject(AttendanceService) private readonly service: AttendanceService) {}

  @Post('records')
  // 명세상 200. 멱등 재시도 시 같은 레코드를 돌려주므로 201(Created)이 아니다.
  @HttpCode(HttpStatus.OK)
  record(@Body() body: RecordBody): unknown {
    const recordType = body.recordType;
    if (recordType === undefined || !RECORD_TYPES.includes(recordType as AttendanceRecordType)) {
      throw new ApiError(
        'VALIDATION_ERROR',
        `recordType이 올바르지 않습니다. (${RECORD_TYPES.join(', ')} 중 하나)`,
      );
    }

    const capturedAt =
      body.capturedAt === undefined ? new Date() : new Date(body.capturedAt);
    if (Number.isNaN(capturedAt.getTime())) {
      throw new ApiError('VALIDATION_ERROR', 'capturedAt이 올바른 시각 형식이 아닙니다.');
    }

    const result = this.service.record({
      recordType: recordType as AttendanceRecordType,
      capturedAt,
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.device !== undefined ? { device: body.device } : {}),
      ...(body.clientNonce !== undefined ? { clientNonce: body.clientNonce } : {}),
      ...(body.source !== undefined ? { source: body.source } : {}),
    });

    const data = serialize(result.record);

    // 위치 검증에 실패해도 기록은 저장된다. 앱이 "기록되었으나 승인 대기"를
    // 정확히 표시할 수 있도록 오류 응답에도 data를 함께 돌려준다.
    if (result.unverifiedMessage !== null) {
      throw new ApiError('LOCATION_UNVERIFIED', result.unverifiedMessage, {
        details: [{ reason: result.record.reason, ...result.record.evidence }],
        data,
      });
    }

    return { data };
  }

  @Get('me/today')
  today(): unknown {
    const { memberId } = currentContext();
    return { data: this.service.today(memberId).map(serialize) };
  }

  @Get('me')
  mine(@Query('from') from?: string, @Query('to') to?: string): unknown {
    const { memberId } = currentContext();
    const today = toLocalDate(new Date());
    return {
      data: this.service.listForMember(memberId, from ?? today, to ?? today).map(serialize),
    };
  }

  @Get('members/:memberId')
  forMember(
    @Param('memberId') memberId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): unknown {
    requireManager();
    const today = toLocalDate(new Date());
    return {
      data: this.service.listForMember(memberId, from ?? today, to ?? today).map(serialize),
    };
  }

  @Post('pending-reviews/:id/resolve')
  resolve(
    @Param('id') id: string,
    @Body() body: { action?: string; comment?: string },
  ): unknown {
    requireManager();
    if (body.action !== 'APPROVE' && body.action !== 'REJECT') {
      throw new ApiError('VALIDATION_ERROR', 'action은 APPROVE 또는 REJECT여야 합니다.');
    }
    if (body.comment === undefined || body.comment.trim() === '') {
      // 사유 없는 처리를 막는다. 이 기록 자체가 병원의 자산이 된다.
      throw new ApiError('VALIDATION_ERROR', '처리 사유(comment)는 필수입니다.');
    }
    return { data: serialize(this.service.resolvePending(id, body.action, body.comment)) };
  }
}

function requireManager(): void {
  if (!hasRole('HR_MANAGER') && !hasRole('WARD_MANAGER') && !hasRole('SUPER_ADMIN')) {
    throw new ApiError('FORBIDDEN', '이 작업을 수행할 권한이 없습니다.');
  }
}

function serialize(record: {
  id: string;
  memberId: string;
  workDate: string;
  recordType: string;
  capturedAt: Date;
  verification: string;
  verifyMethod: string | null;
  confidence: string | null;
  worksiteId: string | null;
  reason: string | null;
}): unknown {
  return {
    id: record.id,
    memberId: record.memberId,
    workDate: record.workDate,
    recordType: record.recordType,
    capturedAt: record.capturedAt.toISOString(),
    verification: record.verification,
    verifyMethod: record.verifyMethod,
    confidence: record.confidence,
    worksiteId: record.worksiteId,
    reason: record.reason,
  };
}
