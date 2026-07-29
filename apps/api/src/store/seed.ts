/**
 * 시드 데이터.
 *
 * 두 구현(Memory / Postgres)이 같은 데이터를 적재하도록 한 곳에서 정의한다.
 * 근무표에는 규칙 위반(E→D 퀵 리턴)을 의도적으로 심어두었다 —
 * 규칙 엔진이 실제로 동작하는지 e2e에서 확인하기 위함이다.
 */

import { addDays, daysToUnits, generateHireDateGrants, type LocalDate } from '@mediwork/domain';
import type {
  Department,
  Holiday,
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

/** 시드 asOf. 연차 부여 원장 생성 기준일. */
export const SEED_AS_OF: LocalDate = '2026-07-29';

export const TENANT_SEOUL = '11111111-1111-4111-8111-111111111111';
export const TENANT_BUSAN = '22222222-2222-4222-8222-222222222222';

const WS_SEOUL = '11111111-1111-4111-8111-000000000001';
const WS_BUSAN = '22222222-2222-4222-8222-000000000001';

const DEPT_WARD3 = '11111111-1111-4111-8111-000000000101';
const DEPT_ADMIN = '11111111-1111-4111-8111-000000000102';
const DEPT_BUSAN_WARD = '22222222-2222-4222-8222-000000000101';

export const MEM_KIM = '11111111-1111-4111-8111-000000000201';
export const MEM_PARK = '11111111-1111-4111-8111-000000000202';
export const MEM_LEE = '11111111-1111-4111-8111-000000000203';
export const MEM_BUSAN = '22222222-2222-4222-8222-000000000201';

export const ROSTER_WARD3 = '11111111-1111-4111-8111-000000000301';

/**
 * 근무유형의 결정론적 UUID.
 *
 * 테넌트 접두사 + 코드 순번으로 만든다. uuid 컬럼이므로 16진수만 써야 한다 —
 * 코드 문자열을 그대로 넣으면 'n' 같은 비-16진 문자가 들어가 INSERT가 깨진다.
 */
const SHIFT_ORDER = ['D', 'E', 'N', 'O', 'A', 'ONCALL'] as const;
type ShiftCode = (typeof SHIFT_ORDER)[number];

const shiftId = (tenantId: string, code: ShiftCode): string =>
  `${tenantId.slice(0, 24)}${String(700000 + SHIFT_ORDER.indexOf(code)).padStart(12, '0')}`;

const shiftIdsFor = (tenantId: string): Record<ShiftCode, string> =>
  Object.fromEntries(SHIFT_ORDER.map((code) => [code, shiftId(tenantId, code)])) as Record<
    ShiftCode,
    string
  >;

export const SHIFT_IDS = {
  seoul: shiftIdsFor(TENANT_SEOUL),
  busan: shiftIdsFor(TENANT_BUSAN),
} as const;

export const LEAVE_TYPE_IDS = {
  annual: '11111111-1111-4111-8111-000000000401',
  half: '11111111-1111-4111-8111-000000000402',
  sick: '11111111-1111-4111-8111-000000000403',
  busanAnnual: '22222222-2222-4222-8222-000000000401',
} as const;

export interface SeedData {
  tenants: Tenant[];
  worksites: Worksite[];
  departments: Department[];
  members: Member[];
  shiftTypes: TenantShiftType[];
  geofences: TenantGeofence[];
  accessPoints: TenantWifiAccessPoint[];
  leaveTypes: LeaveType[];
  leaveGrants: TenantLeaveGrant[];
  rosters: Roster[];
  assignments: RosterAssignment[];
  holidays: Holiday[];
}

const SHIFT_DEFS: ReadonlyArray<Omit<TenantShiftType, 'tenantId' | 'id'>> = [
  {
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
    code: 'ONCALL',
    name: '온콜',
    category: 'ONCALL',
    startTime: '18:00',
    endTime: '09:00',
    breakMinutes: 0,
    paidMinutesOverride: null,
    countsAsWork: true,
    // 자택 대기 온콜은 호출 응대 시간만 근로시간으로 본다.
    dutyMode: 'CALL_ONLY',
    dutyRatio: null,
    isNight: true,
  },
];

export function buildSeed(): SeedData {
  const tenants: Tenant[] = [
    { id: TENANT_SEOUL, name: '서울메디컬병원' },
    { id: TENANT_BUSAN, name: '부산요양병원' },
  ];

  const worksites: Worksite[] = [
    {
      id: WS_SEOUL,
      tenantId: TENANT_SEOUL,
      name: '본원',
      employeeCountTier: 'FROM_50',
      // 보건업 근로시간 특례 서면합의가 유효한 사업장
      specialExceptionAgreement: { effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31' },
    },
    {
      id: WS_BUSAN,
      tenantId: TENANT_BUSAN,
      name: '부산본원',
      employeeCountTier: 'FROM_5',
      specialExceptionAgreement: null,
    },
  ];

  const departments: Department[] = [
    {
      id: DEPT_WARD3,
      tenantId: TENANT_SEOUL,
      worksiteId: WS_SEOUL,
      name: '3병동',
      deptType: 'WARD',
      path: 'hospital.nursing.ward3',
    },
    {
      id: DEPT_ADMIN,
      tenantId: TENANT_SEOUL,
      worksiteId: WS_SEOUL,
      name: '원무팀',
      deptType: 'ADMIN',
      path: 'hospital.admin',
    },
    {
      id: DEPT_BUSAN_WARD,
      tenantId: TENANT_BUSAN,
      worksiteId: WS_BUSAN,
      name: '1병동',
      deptType: 'WARD',
      path: 'hospital.nursing.ward1',
    },
  ];

  const members: Member[] = [
    {
      id: MEM_KIM,
      tenantId: TENANT_SEOUL,
      employeeNo: 'N2301',
      name: '김간호',
      worksiteId: WS_SEOUL,
      departmentId: DEPT_WARD3,
      jobFamily: 'NURSE',
      employmentType: 'REGULAR',
      hireDate: '2021-03-02',
      status: 'ACTIVE',
    },
    {
      id: MEM_PARK,
      tenantId: TENANT_SEOUL,
      employeeNo: 'N1902',
      name: '박수간',
      worksiteId: WS_SEOUL,
      departmentId: DEPT_WARD3,
      jobFamily: 'NURSE',
      employmentType: 'REGULAR',
      hireDate: '2015-09-01',
      status: 'ACTIVE',
    },
    {
      id: MEM_LEE,
      tenantId: TENANT_SEOUL,
      employeeNo: 'A2405',
      name: '이원무',
      worksiteId: WS_SEOUL,
      departmentId: DEPT_ADMIN,
      jobFamily: 'ADMIN',
      employmentType: 'REGULAR',
      hireDate: '2024-05-13',
      status: 'ACTIVE',
    },
    {
      id: MEM_BUSAN,
      tenantId: TENANT_BUSAN,
      employeeNo: 'B0001',
      name: '최간호',
      worksiteId: WS_BUSAN,
      departmentId: DEPT_BUSAN_WARD,
      jobFamily: 'NURSE',
      employmentType: 'REGULAR',
      hireDate: '2022-01-03',
      status: 'ACTIVE',
    },
  ];

  const shiftTypes: TenantShiftType[] = [];
  for (const [tenantId, ids] of [
    [TENANT_SEOUL, SHIFT_IDS.seoul],
    [TENANT_BUSAN, SHIFT_IDS.busan],
  ] as const) {
    for (const def of SHIFT_DEFS) {
      shiftTypes.push({
        ...def,
        id: ids[def.code as keyof typeof ids],
        tenantId,
      });
    }
  }

  const geofences: TenantGeofence[] = [
    {
      id: '11111111-1111-4111-8111-000000000501',
      tenantId: TENANT_SEOUL,
      worksiteId: WS_SEOUL,
      name: '본원',
      centerLat: 37.5268,
      centerLng: 127.1085,
      radiusM: 200,
      isActive: true,
    },
    {
      id: '22222222-2222-4222-8222-000000000501',
      tenantId: TENANT_BUSAN,
      worksiteId: WS_BUSAN,
      name: '부산본원',
      centerLat: 35.1796,
      centerLng: 129.0756,
      radiusM: 150,
      isActive: true,
    },
  ];

  const accessPoints: TenantWifiAccessPoint[] = [
    {
      bssid: 'a4:2b:8c:11:22:33',
      tenantId: TENANT_SEOUL,
      worksiteId: WS_SEOUL,
      label: '3층 간호사실',
      isActive: true,
    },
    {
      bssid: 'a4:2b:8c:11:22:34',
      tenantId: TENANT_SEOUL,
      worksiteId: WS_SEOUL,
      label: '1층 원무과',
      isActive: true,
    },
    {
      bssid: 'b8:27:eb:aa:bb:cc',
      tenantId: TENANT_BUSAN,
      worksiteId: WS_BUSAN,
      isActive: true,
    },
  ];

  const leaveTypes: LeaveType[] = [
    {
      id: LEAVE_TYPE_IDS.annual,
      tenantId: TENANT_SEOUL,
      code: 'ANNUAL',
      name: '연차',
      isPaid: true,
      deductsFromBalance: true,
      balanceSource: 'ANNUAL',
    },
    {
      id: LEAVE_TYPE_IDS.half,
      tenantId: TENANT_SEOUL,
      code: 'ANNUAL_HALF',
      name: '반차',
      isPaid: true,
      deductsFromBalance: true,
      balanceSource: 'ANNUAL',
    },
    {
      id: LEAVE_TYPE_IDS.sick,
      tenantId: TENANT_SEOUL,
      code: 'SICK',
      name: '병가',
      isPaid: false,
      deductsFromBalance: false,
      balanceSource: null,
    },
    {
      id: LEAVE_TYPE_IDS.busanAnnual,
      tenantId: TENANT_BUSAN,
      code: 'ANNUAL',
      name: '연차',
      isPaid: true,
      deductsFromBalance: true,
      balanceSource: 'ANNUAL',
    },
  ];

  // 연차 부여 원장은 도메인 로직으로 생성한다. 시드에도 같은 함수를 쓴다.
  const leaveGrants: TenantLeaveGrant[] = [];
  // uuid 컬럼이므로 결정론적 uuid로 바꾼다. 테넌트 접두사(24자)가 구성원 간
  // 동일하므로 구성원별 인덱스를 쓰면 충돌한다 — 전역 카운터를 쓴다.
  let grantSeq = 0;
  for (const member of members) {
    const grants = generateHireDateGrants({
      memberId: member.id,
      hireDate: member.hireDate,
      asOf: SEED_AS_OF,
      idPrefix: 'seed',
    });
    for (const grant of grants) {
      grantSeq += 1;
      leaveGrants.push({
        ...grant,
        id: `${member.tenantId.slice(0, 24)}${String(800000 + grantSeq).padStart(12, '0')}`,
        tenantId: member.tenantId,
      });
    }
  }
  // 김간호는 일부 사용한 상태로 둔다.
  const kimGrants = leaveGrants.filter((g) => g.memberId === MEM_KIM);
  const latest = kimGrants[kimGrants.length - 1];
  if (latest !== undefined) {
    leaveGrants[leaveGrants.indexOf(latest)] = {
      ...latest,
      usedUnits: daysToUnits(6.5),
    };
  }

  const rosters: Roster[] = [
    {
      id: ROSTER_WARD3,
      tenantId: TENANT_SEOUL,
      departmentId: DEPT_WARD3,
      periodStart: '2026-08-03',
      periodEnd: '2026-08-09',
      status: 'DRAFT',
      version: 1,
    },
  ];

  // 8/07 E → 8/08 D : 퀵 리턴(E→D). 금지 패턴이자 11시간 휴식 위반.
  const pattern: Record<string, readonly string[]> = {
    [MEM_KIM]: ['D', 'D', 'N', 'N', 'E', 'D', 'O'],
    [MEM_PARK]: ['E', 'E', 'D', 'D', 'O', 'N', 'N'],
  };

  const assignments: RosterAssignment[] = [];
  let seq = 0;
  for (const [memberId, codes] of Object.entries(pattern)) {
    codes.forEach((code, index) => {
      seq += 1;
      assignments.push({
        id: `11111111-1111-4111-8111-${String(600000 + seq).padStart(12, '0')}`,
        tenantId: TENANT_SEOUL,
        rosterId: ROSTER_WARD3,
        memberId,
        workDate: addDays('2026-08-03', index),
        shiftTypeId: SHIFT_IDS.seoul[code as keyof typeof SHIFT_IDS.seoul],
        source: 'MANUAL',
      });
    });
  }

  const holidays: Holiday[] = [
    { tenantId: TENANT_SEOUL, date: '2026-08-15', name: '광복절' },
  ];

  return {
    tenants,
    worksites,
    departments,
    members,
    shiftTypes,
    geofences,
    accessPoints,
    leaveTypes,
    leaveGrants,
    rosters,
    assignments,
    holidays,
  };
}
