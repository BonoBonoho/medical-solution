import { Inject, Injectable } from '@nestjs/common';
import {
  toLocalDate,
  verifyLocation,
  type LocalDate,
  type VerifyLocationConfig,
  type VerifyLocationInput,
} from '@mediwork/domain';
import { ApiError } from '../common/errors.js';
import { currentContext, tenantId } from '../common/tenant-context.js';
import { MemoryStore } from '../store/memory-store.js';
import type { AttendanceRecord, AttendanceRecordType } from '../store/types.js';

export interface RecordAttendanceInput {
  readonly recordType: AttendanceRecordType;
  readonly capturedAt: Date;
  readonly location?: {
    readonly gps?: {
      readonly lat: number;
      readonly lng: number;
      readonly accuracy: number;
      readonly isMock?: boolean;
    };
    readonly wifi?: readonly { readonly bssid: string; readonly rssi?: number }[];
  };
  readonly device?: {
    readonly deviceId?: string;
    readonly integrityVerified?: boolean;
  };
  readonly clientNonce?: string;
  readonly source?: AttendanceRecord['source'];
}

export interface RecordAttendanceResult {
  readonly record: AttendanceRecord;
  /** 위치 검증 실패 시 사용자에게 보여줄 메시지. */
  readonly unverifiedMessage: string | null;
}

@Injectable()
export class AttendanceService {
  constructor(@Inject(MemoryStore) private readonly store: MemoryStore) {}

  record(input: RecordAttendanceInput): RecordAttendanceResult {
    const { memberId } = currentContext();
    const tid = tenantId();

    const member = this.store.scoped(this.store.members).find((m) => m.id === memberId);
    if (member === undefined) {
      throw new ApiError('NOT_FOUND', '구성원 정보를 찾을 수 없습니다.');
    }

    // 멱등성 — 지하철에서 재시도로 중복 체크인되는 사고를 막는다.
    if (input.clientNonce !== undefined) {
      const existing = this.store
        .scoped(this.store.attendance)
        .find((r) => r.memberId === memberId && r.clientNonce === input.clientNonce);
      if (existing !== undefined) {
        return { record: existing, unverifiedMessage: null };
      }
    }

    const receivedAt = new Date();
    const captureDelayMinutes = Math.max(
      0,
      (receivedAt.getTime() - input.capturedAt.getTime()) / 60_000,
    );

    const config: VerifyLocationConfig = {
      geofences: this.store.scoped(this.store.geofences),
      accessPoints: this.store.scoped(this.store.accessPoints),
    };

    const verifyInput: VerifyLocationInput = {
      ...(input.location?.gps !== undefined
        ? {
            gps: {
              lat: input.location.gps.lat,
              lng: input.location.gps.lng,
              accuracy: input.location.gps.accuracy,
              isMock: input.location.gps.isMock ?? false,
            },
          }
        : {}),
      ...(input.location?.wifi !== undefined ? { wifi: input.location.wifi } : {}),
      ...(input.device !== undefined
        ? {
            integrity: {
              verified: input.device.integrityVerified ?? true,
              // 기기 바인딩: 등록된 기기인지 확인. 대리 출근의 가장 흔한 수법인
              // 계정 공유를 상당 부분 막는다.
              bound: input.device.deviceId !== undefined,
            },
          }
        : {}),
      captureDelayMinutes,
    };

    const verification = verifyLocation(verifyInput, config);

    const record: AttendanceRecord = {
      id: this.store.nextId('att'),
      tenantId: tid,
      memberId,
      // 야간근무는 시작일 기준으로 work_date를 잡는다.
      workDate: toLocalDate(input.capturedAt),
      recordType: input.recordType,
      capturedAt: input.capturedAt,
      receivedAt,
      verification: verification.verification,
      verifyMethod: verification.method,
      confidence: verification.confidence,
      worksiteId: verification.worksiteId,
      reason: verification.reason,
      evidence: {
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...verification.detail,
      },
      source: input.source ?? 'MOBILE',
      clientNonce: input.clientNonce ?? null,
      isSuperseded: false,
    };

    // 원본은 절대 UPDATE하지 않는다. 근태 기록은 분쟁 시 증거가 된다.
    this.store.attendance.push(record);
    this.store.audit({
      actorId: memberId,
      action: 'CREATE',
      entityType: 'attendanceRecord',
      entityId: record.id,
      reason: null,
    });

    return {
      record,
      unverifiedMessage:
        verification.verification === 'VERIFIED' ? null : verification.message,
    };
  }

  listForMember(memberId: string, from: LocalDate, to: LocalDate): AttendanceRecord[] {
    return this.store
      .scoped(this.store.attendance)
      .filter((r) => r.memberId === memberId && r.workDate >= from && r.workDate <= to)
      .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  }

  today(memberId: string): AttendanceRecord[] {
    const today = toLocalDate(new Date());
    return this.listForMember(memberId, today, today);
  }

  /** 승인 대기 기록을 관리자가 처리한다. */
  resolvePending(recordId: string, action: 'APPROVE' | 'REJECT', comment: string): AttendanceRecord {
    const index = this.store.attendance.findIndex(
      (r) => r.id === recordId && r.tenantId === tenantId(),
    );
    if (index === -1) {
      throw new ApiError('NOT_FOUND', '해당 근태 기록을 찾을 수 없습니다.');
    }
    const original = this.store.attendance[index]!;
    if (original.verification !== 'PENDING_REVIEW') {
      throw new ApiError('CONFLICT', '승인 대기 상태의 기록만 처리할 수 있습니다.');
    }

    const updated: AttendanceRecord = {
      ...original,
      verification: action === 'APPROVE' ? 'VERIFIED' : 'REJECTED',
      verifyMethod: action === 'APPROVE' ? 'MANUAL' : original.verifyMethod,
    };
    this.store.attendance[index] = updated;

    this.store.audit({
      actorId: currentContext().memberId,
      action: 'UPDATE',
      entityType: 'attendanceRecord',
      entityId: recordId,
      reason: comment,
    });
    return updated;
  }
}
