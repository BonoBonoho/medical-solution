/**
 * 저장소 포트.
 *
 * 서비스는 이 인터페이스에만 의존한다. 구현은 두 가지다.
 *   · MemoryStore — 개발·빠른 테스트용
 *   · PgStore     — PostgreSQL + RLS. 운영용
 *
 * 같은 e2e 테스트를 두 구현 모두에 대해 돌려, 어느 쪽으로 바꿔도 동작이
 * 같음을 보장한다. 모든 메서드는 이미 테넌트 스코프가 걸린 결과를 돌려준다 —
 * 호출부가 tenantId 필터를 붙일 일이 없어야 실수도 없다.
 */

import type { LocalDate } from '@mediwork/domain';
import type {
  AttendanceRecord,
  AuditLogEntry,
  Department,
  Holiday,
  LeaveRequest,
  LeaveType,
  Member,
  Roster,
  RosterAssignment,
  TenantGeofence,
  TenantLeaveGrant,
  TenantShiftType,
  TenantWifiAccessPoint,
  Worksite,
} from './types.js';

export interface MemberRepository {
  findById(id: string): Promise<Member | null>;
  listByIds(ids: readonly string[]): Promise<Member[]>;
  listByDepartment(departmentId: string): Promise<Member[]>;
}

export interface WorksiteRepository {
  findById(id: string): Promise<Worksite | null>;
}

export interface LocationRepository {
  listActiveGeofences(): Promise<TenantGeofence[]>;
  listActiveAccessPoints(): Promise<TenantWifiAccessPoint[]>;
}

export interface AttendanceRepository {
  findByNonce(memberId: string, clientNonce: string): Promise<AttendanceRecord | null>;
  findById(id: string): Promise<AttendanceRecord | null>;
  insert(record: AttendanceRecord): Promise<AttendanceRecord>;
  /** 검증 상태 전이만 허용한다. 원본 기록 자체는 덮어쓰지 않는다. */
  updateVerification(
    id: string,
    patch: Pick<AttendanceRecord, 'verification' | 'verifyMethod'>,
  ): Promise<AttendanceRecord>;
  listByMember(memberId: string, from: LocalDate, to: LocalDate): Promise<AttendanceRecord[]>;
}

export interface RosterRepository {
  findById(id: string): Promise<Roster | null>;
  listAssignments(rosterId: string): Promise<RosterAssignment[]>;
  setStatus(id: string, status: Roster['status']): Promise<void>;
  listShiftTypes(): Promise<TenantShiftType[]>;
  listHolidays(): Promise<Holiday[]>;
}

export interface LeaveRepository {
  findLeaveType(id: string): Promise<LeaveType | null>;
  listGrants(memberId: string): Promise<TenantLeaveGrant[]>;
  saveGrants(grants: readonly TenantLeaveGrant[]): Promise<void>;
  insertRequest(
    request: LeaveRequest,
    deductions: readonly { grantId: string; units: number }[],
  ): Promise<LeaveRequest>;
  findRequest(id: string): Promise<LeaveRequest | null>;
  setRequestStatus(id: string, status: LeaveRequest['status']): Promise<void>;
  listRequestsByMember(memberId: string): Promise<LeaveRequest[]>;
  listOverlappingRequests(
    memberIds: readonly string[],
    from: LocalDate,
    to: LocalDate,
  ): Promise<LeaveRequest[]>;
}

export interface AuditRepository {
  append(entry: Omit<AuditLogEntry, 'id' | 'tenantId' | 'occurredAt'>): Promise<void>;
  /** 테스트·검증용. 운영 코드에서는 쓰지 않는다. */
  list(): Promise<AuditLogEntry[]>;
}

export interface Store {
  readonly kind: 'memory' | 'postgres';
  readonly members: MemberRepository;
  readonly worksites: WorksiteRepository;
  readonly locations: LocationRepository;
  readonly attendance: AttendanceRepository;
  readonly rosters: RosterRepository;
  readonly leaves: LeaveRepository;
  readonly audit: AuditRepository;

  /** 새 엔티티 식별자. Postgres 구현은 uuid를 쓴다. */
  nextId(prefix: string): string;
  /** 시드 데이터 적재. 개발·테스트에서만 호출한다. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export const STORE = Symbol('STORE');

export class DuplicateNonceError extends Error {
  constructor(readonly clientNonce: string) {
    super(`이미 처리된 요청입니다 (clientNonce=${clientNonce})`);
    this.name = 'DuplicateNonceError';
  }
}
