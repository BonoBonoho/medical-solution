/**
 * 인메모리 저장소. 개발과 빠른 테스트용.
 *
 * 운영은 PgStore(PostgreSQL + RLS)를 쓴다. 여기서도 모든 조회가 테넌트
 * 스코프를 거치게 해, 구현을 바꿔도 서비스 코드가 동일하게 동작한다.
 */

import { randomUUID } from 'node:crypto';
import type { LocalDate } from '@mediwork/domain';
import { tenantId } from '../common/tenant-context.js';
import { buildSeed } from './seed.js';
import {
  DuplicateNonceError,
  type AttendanceRepository,
  type AuditRepository,
  type LeaveRepository,
  type LocationRepository,
  type MemberRepository,
  type RosterRepository,
  type Store,
  type WorksiteRepository,
} from './ports.js';
import type {
  AttendanceRecord,
  AuditLogEntry,
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

interface HasTenant {
  readonly tenantId: string;
}

interface Tables {
  worksites: Worksite[];
  members: Member[];
  shiftTypes: TenantShiftType[];
  geofences: TenantGeofence[];
  accessPoints: TenantWifiAccessPoint[];
  leaveTypes: LeaveType[];
  leaveGrants: TenantLeaveGrant[];
  leaveRequests: LeaveRequest[];
  leaveDeductions: { tenantId: string; requestId: string; grantId: string; units: number }[];
  rosters: Roster[];
  assignments: RosterAssignment[];
  attendance: AttendanceRecord[];
  holidays: Holiday[];
  audit: AuditLogEntry[];
}

function emptyTables(): Tables {
  return {
    worksites: [],
    members: [],
    shiftTypes: [],
    geofences: [],
    accessPoints: [],
    leaveTypes: [],
    leaveGrants: [],
    leaveRequests: [],
    leaveDeductions: [],
    rosters: [],
    assignments: [],
    attendance: [],
    holidays: [],
    audit: [],
  };
}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private t: Tables = emptyTables();

  constructor() {
    this.load();
  }

  private scoped<T extends HasTenant>(rows: readonly T[]): T[] {
    const tid = tenantId();
    return rows.filter((row) => row.tenantId === tid);
  }

  private load(): void {
    const seed = buildSeed();
    this.t = emptyTables();
    this.t.worksites.push(...seed.worksites);
    this.t.members.push(...seed.members);
    this.t.shiftTypes.push(...seed.shiftTypes);
    this.t.geofences.push(...seed.geofences);
    this.t.accessPoints.push(...seed.accessPoints);
    this.t.leaveTypes.push(...seed.leaveTypes);
    this.t.leaveGrants.push(...seed.leaveGrants);
    this.t.rosters.push(...seed.rosters);
    this.t.assignments.push(...seed.assignments);
    this.t.holidays.push(...seed.holidays);
  }

  nextId(): string {
    return randomUUID();
  }

  async reset(): Promise<void> {
    this.load();
  }

  async close(): Promise<void> {
    /* no-op */
  }

  readonly members: MemberRepository = {
    findById: async (id) => this.scoped(this.t.members).find((m) => m.id === id) ?? null,
    listByIds: async (ids) => this.scoped(this.t.members).filter((m) => ids.includes(m.id)),
    listByDepartment: async (departmentId) =>
      this.scoped(this.t.members).filter((m) => m.departmentId === departmentId),
  };

  readonly worksites: WorksiteRepository = {
    findById: async (id) => this.scoped(this.t.worksites).find((w) => w.id === id) ?? null,
  };

  readonly locations: LocationRepository = {
    listActiveGeofences: async () => this.scoped(this.t.geofences).filter((g) => g.isActive),
    listActiveAccessPoints: async () => this.scoped(this.t.accessPoints).filter((a) => a.isActive),
  };

  readonly attendance: AttendanceRepository = {
    findByNonce: async (memberId, clientNonce) =>
      this.scoped(this.t.attendance).find(
        (r) => r.memberId === memberId && r.clientNonce === clientNonce,
      ) ?? null,
    findById: async (id) => this.scoped(this.t.attendance).find((r) => r.id === id) ?? null,
    insert: async (record) => {
      if (record.clientNonce !== null) {
        const dup = this.scoped(this.t.attendance).find(
          (r) => r.memberId === record.memberId && r.clientNonce === record.clientNonce,
        );
        if (dup !== undefined) throw new DuplicateNonceError(record.clientNonce);
      }
      this.t.attendance.push(record);
      return record;
    },
    updateVerification: async (id, patch) => {
      const index = this.t.attendance.findIndex(
        (r) => r.id === id && r.tenantId === tenantId(),
      );
      if (index === -1) throw new Error(`attendance ${id} not found`);
      const updated = { ...this.t.attendance[index]!, ...patch };
      this.t.attendance[index] = updated;
      return updated;
    },
    listByMember: async (memberId, from, to) =>
      this.scoped(this.t.attendance)
        .filter((r) => r.memberId === memberId && r.workDate >= from && r.workDate <= to)
        .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime()),
  };

  readonly rosters: RosterRepository = {
    findById: async (id) => this.scoped(this.t.rosters).find((r) => r.id === id) ?? null,
    listAssignments: async (rosterId) =>
      this.scoped(this.t.assignments).filter((a) => a.rosterId === rosterId),
    setStatus: async (id, status) => {
      const index = this.t.rosters.findIndex((r) => r.id === id && r.tenantId === tenantId());
      if (index === -1) return;
      this.t.rosters[index] = { ...this.t.rosters[index]!, status };
    },
    listShiftTypes: async () => this.scoped(this.t.shiftTypes),
    listHolidays: async () => this.scoped(this.t.holidays),
  };

  readonly leaves: LeaveRepository = {
    findLeaveType: async (id) => this.scoped(this.t.leaveTypes).find((t) => t.id === id) ?? null,
    listGrants: async (memberId) =>
      this.scoped(this.t.leaveGrants).filter((g) => g.memberId === memberId),
    saveGrants: async (grants) => {
      for (const grant of grants) {
        const index = this.t.leaveGrants.findIndex((g) => g.id === grant.id);
        if (index === -1) this.t.leaveGrants.push(grant);
        else this.t.leaveGrants[index] = grant;
      }
    },
    insertRequest: async (request, deductions) => {
      this.t.leaveRequests.push(request);
      for (const d of deductions) {
        this.t.leaveDeductions.push({
          tenantId: request.tenantId,
          requestId: request.id,
          grantId: d.grantId,
          units: d.units,
        });
      }
      return request;
    },
    findRequest: async (id) => this.scoped(this.t.leaveRequests).find((r) => r.id === id) ?? null,
    setRequestStatus: async (id, status) => {
      const index = this.t.leaveRequests.findIndex(
        (r) => r.id === id && r.tenantId === tenantId(),
      );
      if (index === -1) return;
      this.t.leaveRequests[index] = { ...this.t.leaveRequests[index]!, status };
    },
    listRequestsByMember: async (memberId) =>
      this.scoped(this.t.leaveRequests)
        .filter((r) => r.memberId === memberId)
        .sort((a, b) => b.startDate.localeCompare(a.startDate)),
    listOverlappingRequests: async (memberIds, from, to) =>
      this.scoped(this.t.leaveRequests).filter(
        (r) =>
          memberIds.includes(r.memberId) &&
          r.status !== 'CANCELLED' &&
          r.status !== 'REJECTED' &&
          r.startDate <= to &&
          r.endDate >= from,
      ),
  };

  readonly audit: AuditRepository = {
    append: async (entry) => {
      this.t.audit.push({
        ...entry,
        id: randomUUID(),
        tenantId: tenantId(),
        occurredAt: new Date(),
      });
    },
    list: async () => this.scoped(this.t.audit),
  };
}

export type { LocalDate };
