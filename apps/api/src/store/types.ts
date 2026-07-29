import type {
  Confidence,
  EmploymentType,
  Geofence,
  JobFamily,
  LeaveGrant,
  LocalDate,
  ShiftType,
  Verification,
  VerifyMethod,
  WifiAccessPoint,
} from '@mediwork/domain';

export interface Tenant {
  readonly id: string;
  readonly name: string;
}

export interface Worksite {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  /** 규칙 적용을 좌우한다. 5인 미만은 가산수당 규정이 적용되지 않는다. */
  readonly employeeCountTier: 'UNDER_5' | 'FROM_5' | 'FROM_50' | 'FROM_300';
  /** 근로시간 특례 서면합의. 만료되면 52시간 규칙이 되살아난다. */
  readonly specialExceptionAgreement: {
    readonly effectiveFrom: LocalDate;
    readonly effectiveTo: LocalDate;
  } | null;
}

export interface Department {
  readonly id: string;
  readonly tenantId: string;
  readonly worksiteId: string;
  readonly name: string;
  readonly deptType: 'CLINICAL_DEPT' | 'WARD' | 'ADMIN' | 'FACILITY';
  /** 조직 트리 경로. 권한 스코프 판정에 쓴다. */
  readonly path: string;
}

export interface Member {
  readonly id: string;
  readonly tenantId: string;
  readonly employeeNo: string;
  readonly name: string;
  readonly worksiteId: string;
  readonly departmentId: string;
  readonly jobFamily: JobFamily;
  readonly employmentType: EmploymentType;
  readonly hireDate: LocalDate;
  readonly status: 'ACTIVE' | 'ON_LEAVE' | 'RESIGNED';
}

export interface TenantShiftType extends ShiftType {
  readonly id: string;
  readonly tenantId: string;
}

export interface RosterAssignment {
  readonly id: string;
  readonly tenantId: string;
  readonly rosterId: string;
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly shiftTypeId: string;
  readonly source: 'MANUAL' | 'AI' | 'PATTERN' | 'SWAP';
}

export interface Roster {
  readonly id: string;
  readonly tenantId: string;
  readonly departmentId: string;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly status: 'DRAFT' | 'REVIEW' | 'PUBLISHED' | 'CLOSED';
  readonly version: number;
}

export type AttendanceRecordType =
  | 'CHECK_IN'
  | 'CHECK_OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'CALL_START'
  | 'CALL_END';

export interface AttendanceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly memberId: string;
  readonly workDate: LocalDate;
  readonly recordType: AttendanceRecordType;
  readonly capturedAt: Date;
  readonly receivedAt: Date;
  readonly verification: Verification;
  readonly verifyMethod: VerifyMethod | null;
  readonly confidence: Confidence | null;
  readonly worksiteId: string | null;
  readonly reason: string | null;
  /**
   * 원시 증거. 90일 후 위치 원본은 삭제하고 검증 결과만 남긴다.
   * (docs/10-security-compliance.md §2.2)
   */
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly source: 'MOBILE' | 'WEB' | 'KIOSK' | 'ADMIN' | 'IMPORT';
  readonly clientNonce: string | null;
  readonly isSuperseded: boolean;
}

export interface LeaveType {
  readonly id: string;
  readonly tenantId: string;
  readonly code: string;
  readonly name: string;
  readonly isPaid: boolean;
  readonly deductsFromBalance: boolean;
  readonly balanceSource: 'ANNUAL' | 'COMP_LEAVE' | null;
}

export interface LeaveRequest {
  readonly id: string;
  readonly tenantId: string;
  readonly memberId: string;
  readonly leaveTypeId: string;
  readonly startDate: LocalDate;
  readonly endDate: LocalDate;
  readonly units: number;
  readonly reason: string | null;
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  readonly deductions: readonly { grantId: string; units: number }[];
}

export interface TenantLeaveGrant extends LeaveGrant {
  readonly tenantId: string;
}

export interface TenantGeofence extends Geofence {
  readonly tenantId: string;
}

export interface TenantWifiAccessPoint extends WifiAccessPoint {
  readonly tenantId: string;
}

/** 공휴일·약정휴일. 휴일근로 가산 판정에 쓴다. */
export interface Holiday {
  readonly tenantId: string;
  readonly date: LocalDate;
  readonly name: string;
}

export interface AuditLogEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
}
