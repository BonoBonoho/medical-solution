import { Injectable } from '@nestjs/common';
import {
  addDays,
  daysToUnits,
  generateHireDateGrants,
  type LocalDate,
} from '@mediwork/domain';
import { tenantId } from '../common/tenant-context.js';
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
  Tenant,
  Worksite,
} from './types.js';

interface HasTenant {
  readonly tenantId: string;
}

/**
 * 개발·테스트용 인메모리 저장소.
 *
 * 운영에서는 PostgreSQL + RLS로 교체한다. 다만 여기서도 테넌트 스코프를
 * 강제해 애플리케이션 코드가 tenantId 필터를 빠뜨릴 수 없게 만든다 —
 * 실수를 저장소 계층에서 잡는 구조는 DB로 옮겨가도 그대로 유지된다.
 */
@Injectable()
export class MemoryStore {
  readonly tenants: Tenant[] = [];
  readonly worksites: Worksite[] = [];
  readonly departments: Department[] = [];
  readonly members: Member[] = [];
  readonly shiftTypes: TenantShiftType[] = [];
  readonly rosters: Roster[] = [];
  readonly assignments: RosterAssignment[] = [];
  readonly attendance: AttendanceRecord[] = [];
  readonly leaveTypes: LeaveType[] = [];
  readonly leaveGrants: TenantLeaveGrant[] = [];
  readonly leaveRequests: LeaveRequest[] = [];
  readonly geofences: TenantGeofence[] = [];
  readonly accessPoints: TenantWifiAccessPoint[] = [];
  readonly holidays: Holiday[] = [];
  readonly auditLog: AuditLogEntry[] = [];

  private sequence = 0;

  constructor() {
    this.seed();
  }

  nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(6, '0')}`;
  }

  /** 현재 테넌트로 스코프를 건 조회. 모든 읽기는 이 함수를 거친다. */
  scoped<T extends HasTenant>(collection: readonly T[]): T[] {
    const tid = tenantId();
    return collection.filter((row) => row.tenantId === tid);
  }

  audit(entry: Omit<AuditLogEntry, 'id' | 'tenantId' | 'occurredAt'>): void {
    this.auditLog.push({
      ...entry,
      id: this.nextId('audit'),
      tenantId: tenantId(),
      occurredAt: new Date(),
    });
  }

  private seed(): void {
    const t1 = 'tenant_seoul';
    const t2 = 'tenant_busan';

    this.tenants.push(
      { id: t1, name: '서울메디컬병원' },
      { id: t2, name: '부산요양병원' },
    );

    this.worksites.push(
      {
        id: 'ws_seoul_main',
        tenantId: t1,
        name: '본원',
        employeeCountTier: 'FROM_50',
        // 보건업 근로시간 특례 서면합의가 유효한 사업장
        specialExceptionAgreement: {
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-12-31',
        },
      },
      {
        id: 'ws_busan',
        tenantId: t2,
        name: '부산본원',
        employeeCountTier: 'FROM_5',
        specialExceptionAgreement: null,
      },
    );

    this.departments.push(
      {
        id: 'dept_ward3',
        tenantId: t1,
        worksiteId: 'ws_seoul_main',
        name: '3병동',
        deptType: 'WARD',
        path: 'hospital.nursing.ward3',
      },
      {
        id: 'dept_admin',
        tenantId: t1,
        worksiteId: 'ws_seoul_main',
        name: '원무팀',
        deptType: 'ADMIN',
        path: 'hospital.admin',
      },
      {
        id: 'dept_busan_ward',
        tenantId: t2,
        worksiteId: 'ws_busan',
        name: '1병동',
        deptType: 'WARD',
        path: 'hospital.nursing.ward1',
      },
    );

    this.members.push(
      {
        id: 'mem_kim',
        tenantId: t1,
        employeeNo: 'N2301',
        name: '김간호',
        worksiteId: 'ws_seoul_main',
        departmentId: 'dept_ward3',
        jobFamily: 'NURSE',
        employmentType: 'REGULAR',
        hireDate: '2021-03-02',
        status: 'ACTIVE',
      },
      {
        id: 'mem_park',
        tenantId: t1,
        employeeNo: 'N1902',
        name: '박수간',
        worksiteId: 'ws_seoul_main',
        departmentId: 'dept_ward3',
        jobFamily: 'NURSE',
        employmentType: 'REGULAR',
        hireDate: '2015-09-01',
        status: 'ACTIVE',
      },
      {
        id: 'mem_lee',
        tenantId: t1,
        employeeNo: 'A2405',
        name: '이원무',
        worksiteId: 'ws_seoul_main',
        departmentId: 'dept_admin',
        jobFamily: 'ADMIN',
        employmentType: 'REGULAR',
        hireDate: '2024-05-13',
        status: 'ACTIVE',
      },
      {
        id: 'mem_busan',
        tenantId: t2,
        employeeNo: 'B0001',
        name: '최간호',
        worksiteId: 'ws_busan',
        departmentId: 'dept_busan_ward',
        jobFamily: 'NURSE',
        employmentType: 'REGULAR',
        hireDate: '2022-01-03',
        status: 'ACTIVE',
      },
    );

    const shiftDefs: Array<Omit<TenantShiftType, 'tenantId'>> = [
      {
        id: 'st_d',
        code: 'D',
        name: '데이',
        category: 'WORK',
        startTime: '07:00',
        endTime: '15:00',
        breakMinutes: 60,
        paidMinutesOverride: null,
        countsAsWork: true,
        dutyMode: null,
        dutyRatio: null,
        isNight: false,
      },
      {
        id: 'st_e',
        code: 'E',
        name: '이브닝',
        category: 'WORK',
        startTime: '15:00',
        endTime: '23:00',
        breakMinutes: 60,
        paidMinutesOverride: null,
        countsAsWork: true,
        dutyMode: null,
        dutyRatio: null,
        isNight: false,
      },
      {
        id: 'st_n',
        code: 'N',
        name: '나이트',
        category: 'WORK',
        startTime: '22:00',
        endTime: '08:00',
        breakMinutes: 60,
        paidMinutesOverride: null,
        countsAsWork: true,
        dutyMode: null,
        dutyRatio: null,
        isNight: true,
      },
      {
        id: 'st_o',
        code: 'O',
        name: '오프',
        category: 'OFF',
        startTime: null,
        endTime: null,
        breakMinutes: 0,
        paidMinutesOverride: null,
        countsAsWork: false,
        dutyMode: null,
        dutyRatio: null,
        isNight: false,
      },
      {
        id: 'st_a',
        code: 'A',
        name: '연차',
        category: 'LEAVE',
        startTime: null,
        endTime: null,
        breakMinutes: 0,
        paidMinutesOverride: null,
        countsAsWork: false,
        dutyMode: null,
        dutyRatio: null,
        isNight: false,
      },
      {
        id: 'st_oncall',
        code: 'ONCALL',
        name: '온콜',
        category: 'ONCALL',
        startTime: '18:00',
        endTime: '09:00',
        breakMinutes: 0,
        paidMinutesOverride: null,
        countsAsWork: true,
        // 자택 대기 온콜은 호출 응대 시간만 근로시간으로 본다
        dutyMode: 'CALL_ONLY',
        dutyRatio: null,
        isNight: true,
      },
    ];
    for (const tid of [t1, t2]) {
      for (const def of shiftDefs) {
        this.shiftTypes.push({ ...def, id: `${def.id}_${tid}`, tenantId: tid });
      }
    }

    this.geofences.push(
      {
        id: 'gf_seoul',
        tenantId: t1,
        worksiteId: 'ws_seoul_main',
        name: '본원',
        centerLat: 37.5268,
        centerLng: 127.1085,
        radiusM: 200,
        isActive: true,
      },
      {
        id: 'gf_busan',
        tenantId: t2,
        worksiteId: 'ws_busan',
        name: '부산본원',
        centerLat: 35.1796,
        centerLng: 129.0756,
        radiusM: 150,
        isActive: true,
      },
    );

    this.accessPoints.push(
      {
        bssid: 'a4:2b:8c:11:22:33',
        tenantId: t1,
        worksiteId: 'ws_seoul_main',
        label: '3층 간호사실',
        isActive: true,
      },
      {
        bssid: 'a4:2b:8c:11:22:34',
        tenantId: t1,
        worksiteId: 'ws_seoul_main',
        label: '1층 원무과',
        isActive: true,
      },
      {
        bssid: 'b8:27:eb:aa:bb:cc',
        tenantId: t2,
        worksiteId: 'ws_busan',
        isActive: true,
      },
    );

    this.leaveTypes.push(
      {
        id: 'lt_annual',
        tenantId: t1,
        code: 'ANNUAL',
        name: '연차',
        isPaid: true,
        deductsFromBalance: true,
        balanceSource: 'ANNUAL',
      },
      {
        id: 'lt_half',
        tenantId: t1,
        code: 'ANNUAL_HALF',
        name: '반차',
        isPaid: true,
        deductsFromBalance: true,
        balanceSource: 'ANNUAL',
      },
      {
        id: 'lt_sick',
        tenantId: t1,
        code: 'SICK',
        name: '병가',
        isPaid: false,
        deductsFromBalance: false,
        balanceSource: null,
      },
      {
        id: 'lt_annual_busan',
        tenantId: t2,
        code: 'ANNUAL',
        name: '연차',
        isPaid: true,
        deductsFromBalance: true,
        balanceSource: 'ANNUAL',
      },
    );

    // 연차 부여 원장을 입사일 기준으로 생성한다.
    const asOf: LocalDate = '2026-07-29';
    for (const member of this.members) {
      const grants = generateHireDateGrants({
        memberId: member.id,
        hireDate: member.hireDate,
        asOf,
      });
      for (const grant of grants) {
        this.leaveGrants.push({ ...grant, tenantId: member.tenantId });
      }
    }
    // 김간호는 일부 사용한 상태로 둔다.
    const kimGrants = this.leaveGrants.filter((g) => g.memberId === 'mem_kim');
    const latest = kimGrants[kimGrants.length - 1];
    if (latest !== undefined) {
      const index = this.leaveGrants.indexOf(latest);
      this.leaveGrants[index] = { ...latest, usedUnits: daysToUnits(6.5) };
    }

    // 2026년 8월 3병동 근무표(초안). 의도적으로 규칙 위반을 하나 심어둔다.
    this.rosters.push({
      id: 'roster_ward3_202608',
      tenantId: t1,
      departmentId: 'dept_ward3',
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      status: 'DRAFT',
      version: 1,
    });

    const pattern: Record<string, string[]> = {
      // 8/6 E → 8/7 D : 퀵 리턴(E→D). 금지 패턴이자 11시간 휴식 위반.
      mem_kim: ['D', 'D', 'N', 'N', 'E', 'D', 'O'],
      mem_park: ['E', 'E', 'D', 'D', 'O', 'N', 'N'],
    };
    for (const [memberId, codes] of Object.entries(pattern)) {
      codes.forEach((code, index) => {
        this.assignments.push({
          id: this.nextId('asg'),
          tenantId: t1,
          rosterId: 'roster_ward3_202608',
          memberId,
          workDate: addDays('2026-08-03', index),
          shiftTypeId: `st_${code.toLowerCase()}_${t1}`,
          source: 'MANUAL',
        });
      });
    }

    this.holidays.push({ tenantId: t1, date: '2026-08-15', name: '광복절' });
  }
}
