/**
 * PostgreSQL 저장소. 운영 구현.
 *
 * 테넌트 스코프는 SQL의 WHERE 절이 아니라 **RLS 정책**이 건다.
 * 이 파일의 질의문에 `tenant_id = $1` 이 거의 없는 것은 실수가 아니라 설계다 —
 * 애플리케이션이 필터를 빠뜨려도 DB가 막는지 확인하기 위해서다.
 * (검증: test/rls.test.ts)
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalDate } from '@mediwork/domain';
import { Db, isUniqueViolation, type PoolClient } from '../db/pool.js';
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

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * pg가 돌려주는 행. 드라이버가 런타임 타입을 알 수 없으므로 느슨하게 받고,
 * 매핑 함수에서 도메인 타입으로 좁힌다. 매핑 함수 밖으로 새어나가지 않는다.
 */
type Row = Record<string, any>;

export class PgStore implements Store {
  readonly kind = 'postgres' as const;

  /**
   * @param db      애플리케이션 연결. 반드시 비-수퍼유저 롤(mediwork_app)이어야
   *                RLS가 적용된다.
   * @param adminDb 마이그레이션·시드 전용 연결(스키마 소유자). 없으면 reset() 불가.
   */
  constructor(
    private readonly db: Db,
    private readonly adminDb?: Db,
  ) {}

  nextId(): string {
    return randomUUID();
  }

  async close(): Promise<void> {
    await this.db.close();
    if (this.adminDb !== undefined) await this.adminDb.close();
  }

  /** 스키마를 적용하고 시드를 적재한다. 개발·테스트 전용. */
  async reset(): Promise<void> {
    const admin = this.adminDb;
    if (admin === undefined) {
      throw new Error('reset()에는 관리자 연결(DATABASE_ADMIN_URL)이 필요합니다.');
    }
    const schema = readFileSync(join(HERE, '..', 'db', 'schema.sql'), 'utf8');
    await admin.withoutTenant(async (c) => {
      await c.query('DROP SCHEMA IF EXISTS public CASCADE');
      await c.query('CREATE SCHEMA public');
      await c.query(schema);
    });
    await this.seed(admin);
  }

  private async seed(admin: Db): Promise<void> {
    const s = buildSeed();
    await admin.withoutTenant(async (c) => {
      // 시드는 RLS를 우회해야 하므로 정책을 잠시 끈다. 요청 경로에서는 불가능하다.
      await c.query('SET row_security = off');

      for (const t of s.tenants) {
        await c.query('INSERT INTO tenant (id, slug, name) VALUES ($1,$2,$3)', [
          t.id,
          t.id.slice(0, 8),
          t.name,
        ]);
      }
      for (const w of s.worksites) {
        await c.query(
          'INSERT INTO worksite (id, tenant_id, name, employee_count_tier) VALUES ($1,$2,$3,$4)',
          [w.id, w.tenantId, w.name, w.employeeCountTier],
        );
        if (w.specialExceptionAgreement !== null) {
          await c.query(
            `INSERT INTO labor_agreement
               (tenant_id, worksite_id, agreement_type, title, effective_from, effective_to)
             VALUES ($1,$2,'SPECIAL_EXCEPTION_59','근로시간 특례 서면합의',$3,$4)`,
            [
              w.tenantId,
              w.id,
              w.specialExceptionAgreement.effectiveFrom,
              w.specialExceptionAgreement.effectiveTo,
            ],
          );
        }
      }
      for (const d of s.departments) {
        await c.query(
          'INSERT INTO department (id, tenant_id, worksite_id, name, dept_type, path) VALUES ($1,$2,$3,$4,$5,$6)',
          [d.id, d.tenantId, d.worksiteId, d.name, d.deptType, d.path],
        );
      }
      for (const m of s.members) {
        await c.query(
          `INSERT INTO member (id, tenant_id, employee_no, name, hire_date, worksite_id,
                               department_id, job_family, employment_type, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            m.id, m.tenantId, m.employeeNo, m.name, m.hireDate, m.worksiteId,
            m.departmentId, m.jobFamily, m.employmentType, m.status,
          ],
        );
      }
      for (const st of s.shiftTypes) {
        await c.query(
          `INSERT INTO shift_type (id, tenant_id, code, name, category, start_time, end_time,
                                   break_minutes, paid_minutes_override, counts_as_work,
                                   duty_mode, duty_ratio, is_night)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            st.id, st.tenantId, st.code, st.name, st.category, st.startTime, st.endTime,
            st.breakMinutes, st.paidMinutesOverride, st.countsAsWork,
            st.dutyMode, st.dutyRatio, st.isNight,
          ],
        );
      }
      for (const g of s.geofences) {
        await c.query(
          `INSERT INTO geofence (id, tenant_id, worksite_id, name, center_lat, center_lng, radius_m, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [g.id, g.tenantId, g.worksiteId, g.name, g.centerLat, g.centerLng, g.radiusM, g.isActive],
        );
      }
      for (const a of s.accessPoints) {
        await c.query(
          `INSERT INTO worksite_wifi_ap (tenant_id, worksite_id, bssid, label, is_active)
           VALUES ($1,$2,$3,$4,$5)`,
          [a.tenantId, a.worksiteId, a.bssid, a.label ?? null, a.isActive],
        );
      }
      for (const lt of s.leaveTypes) {
        await c.query(
          `INSERT INTO leave_type (id, tenant_id, code, name, is_paid, deducts_from_balance, balance_source)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [lt.id, lt.tenantId, lt.code, lt.name, lt.isPaid, lt.deductsFromBalance, lt.balanceSource],
        );
      }
      for (const g of s.leaveGrants) {
        await c.query(
          `INSERT INTO leave_grant (id, tenant_id, member_id, balance_source, grant_reason,
                                    granted_units, used_units, expired_units,
                                    effective_from, expires_at, grant_basis)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            g.id, g.tenantId, g.memberId, g.balanceSource, g.reason,
            g.grantedUnits, g.usedUnits, g.expiredUnits,
            g.effectiveFrom, g.expiresAt, JSON.stringify(g.basis),
          ],
        );
      }
      for (const r of s.rosters) {
        await c.query(
          `INSERT INTO roster (id, tenant_id, department_id, period_start, period_end, status, version)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [r.id, r.tenantId, r.departmentId, r.periodStart, r.periodEnd, r.status, r.version],
        );
      }
      for (const a of s.assignments) {
        await c.query(
          `INSERT INTO roster_assignment (id, tenant_id, roster_id, member_id, work_date, shift_type_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [a.id, a.tenantId, a.rosterId, a.memberId, a.workDate, a.shiftTypeId, a.source],
        );
      }
      for (const h of s.holidays) {
        await c.query('INSERT INTO holiday (tenant_id, holiday_date, name) VALUES ($1,$2,$3)', [
          h.tenantId,
          h.date,
          h.name,
        ]);
      }
      await c.query('SET row_security = on');
    });
  }

  // -------------------------------------------------------------------------

  readonly members: MemberRepository = {
    findById: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(MEMBER_SELECT + ' WHERE id = $1', [id]);
        return rows[0] === undefined ? null : toMember(rows[0]);
      }),
    listByIds: async (ids) =>
      ids.length === 0
        ? []
        : this.db.withTenant(async (c) => {
            const { rows } = await c.query(MEMBER_SELECT + ' WHERE id = ANY($1::uuid[])', [ids]);
            return rows.map(toMember);
          }),
    listByDepartment: async (departmentId) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(MEMBER_SELECT + ' WHERE department_id = $1', [departmentId]);
        return rows.map(toMember);
      }),
  };

  readonly worksites: WorksiteRepository = {
    findById: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT w.id, w.tenant_id, w.name, w.employee_count_tier,
                  la.effective_from, la.effective_to
             FROM worksite w
             LEFT JOIN labor_agreement la
               ON la.worksite_id = w.id
              AND la.agreement_type = 'SPECIAL_EXCEPTION_59'
            WHERE w.id = $1
            LIMIT 1`,
          [id],
        );
        const row = rows[0];
        if (row === undefined) return null;
        return {
          id: row.id,
          tenantId: row.tenant_id,
          name: row.name,
          employeeCountTier: row.employee_count_tier,
          specialExceptionAgreement:
            row.effective_from === null || row.effective_from === undefined
              ? null
              : { effectiveFrom: row.effective_from, effectiveTo: row.effective_to },
        } satisfies Worksite;
      }),
  };

  readonly locations: LocationRepository = {
    listActiveGeofences: async () =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, worksite_id, name, center_lat, center_lng, radius_m, is_active
             FROM geofence WHERE is_active`,
        );
        return rows.map(
          (r: Row): TenantGeofence => ({
            id: r.id,
            tenantId: r.tenant_id,
            worksiteId: r.worksite_id,
            name: r.name,
            centerLat: Number(r.center_lat),
            centerLng: Number(r.center_lng),
            radiusM: r.radius_m,
            isActive: r.is_active,
          }),
        );
      }),
    listActiveAccessPoints: async () =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT tenant_id, worksite_id, bssid::text AS bssid, label, is_active
             FROM worksite_wifi_ap WHERE is_active`,
        );
        return rows.map(
          (r: Row): TenantWifiAccessPoint => ({
            tenantId: r.tenant_id,
            worksiteId: r.worksite_id,
            bssid: r.bssid,
            ...(r.label !== null ? { label: r.label } : {}),
            isActive: r.is_active,
          }),
        );
      }),
  };

  readonly attendance: AttendanceRepository = {
    findByNonce: async (memberId, clientNonce) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          ATTENDANCE_SELECT + ' WHERE member_id = $1 AND client_nonce = $2',
          [memberId, clientNonce],
        );
        return rows[0] === undefined ? null : toAttendance(rows[0]);
      }),
    findById: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(ATTENDANCE_SELECT + ' WHERE id = $1', [id]);
        return rows[0] === undefined ? null : toAttendance(rows[0]);
      }),
    insert: async (record) =>
      this.db.withTenant(async (c) => {
        try {
          const { rows } = await c.query(
            `INSERT INTO attendance_record
               (id, tenant_id, member_id, work_date, record_type, captured_at, received_at,
                verification, verify_method, confidence, worksite_id, reason, evidence,
                source, client_nonce, is_superseded)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             RETURNING id, tenant_id, member_id, work_date, record_type, captured_at, received_at,
                       verification, verify_method, confidence, worksite_id, reason, evidence,
                       source, client_nonce, is_superseded`,
            [
              record.id, record.tenantId, record.memberId, record.workDate, record.recordType,
              record.capturedAt, record.receivedAt, record.verification, record.verifyMethod,
              record.confidence, record.worksiteId, record.reason, JSON.stringify(record.evidence),
              record.source, record.clientNonce, record.isSuperseded,
            ],
          );
          return toAttendance(rows[0]);
        } catch (error) {
          // 멱등성은 애플리케이션 체크와 DB 유니크 인덱스가 이중으로 막는다.
          // 동시 요청에서는 앞의 체크가 통과해도 여기서 걸린다.
          if (isUniqueViolation(error, 'attendance_record_nonce_uq')) {
            throw new DuplicateNonceError(record.clientNonce ?? '');
          }
          throw error;
        }
      }),
    updateVerification: async (id, patch) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `UPDATE attendance_record
              SET verification = $2, verify_method = $3
            WHERE id = $1
            RETURNING id, tenant_id, member_id, work_date, record_type, captured_at, received_at,
                      verification, verify_method, confidence, worksite_id, reason, evidence,
                      source, client_nonce, is_superseded`,
          [id, patch.verification, patch.verifyMethod],
        );
        if (rows[0] === undefined) throw new Error(`attendance ${id} not found`);
        return toAttendance(rows[0]);
      }),
    listByMember: async (memberId, from, to) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          ATTENDANCE_SELECT +
            ' WHERE member_id = $1 AND work_date BETWEEN $2 AND $3 ORDER BY captured_at',
          [memberId, from, to],
        );
        return rows.map(toAttendance);
      }),
  };

  readonly rosters: RosterRepository = {
    findById: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, department_id, period_start, period_end, status, version
             FROM roster WHERE id = $1`,
          [id],
        );
        const r = rows[0];
        return r === undefined
          ? null
          : ({
              id: r.id,
              tenantId: r.tenant_id,
              departmentId: r.department_id,
              periodStart: r.period_start,
              periodEnd: r.period_end,
              status: r.status,
              version: r.version,
            } satisfies Roster);
      }),
    listAssignments: async (rosterId) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, roster_id, member_id, work_date, shift_type_id, source
             FROM roster_assignment WHERE roster_id = $1 ORDER BY member_id, work_date`,
          [rosterId],
        );
        return rows.map(
          (r: Row): RosterAssignment => ({
            id: r.id,
            tenantId: r.tenant_id,
            rosterId: r.roster_id,
            memberId: r.member_id,
            workDate: r.work_date,
            shiftTypeId: r.shift_type_id,
            source: r.source,
          }),
        );
      }),
    setStatus: async (id, status) => {
      await this.db.withTenant(async (c) => {
        await c.query('UPDATE roster SET status = $2 WHERE id = $1', [id, status]);
      });
    },
    listShiftTypes: async () =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, code, name, category,
                  to_char(start_time,'HH24:MI') AS start_time,
                  to_char(end_time,'HH24:MI') AS end_time,
                  break_minutes, paid_minutes_override, counts_as_work,
                  duty_mode, duty_ratio, is_night
             FROM shift_type WHERE is_active`,
        );
        return rows.map(
          (r: Row): TenantShiftType => ({
            id: r.id,
            tenantId: r.tenant_id,
            code: r.code,
            name: r.name,
            category: r.category,
            startTime: r.start_time,
            endTime: r.end_time,
            breakMinutes: r.break_minutes,
            paidMinutesOverride: r.paid_minutes_override,
            countsAsWork: r.counts_as_work,
            dutyMode: r.duty_mode,
            dutyRatio: r.duty_ratio === null ? null : Number(r.duty_ratio),
            isNight: r.is_night,
          }),
        );
      }),
    listHolidays: async () =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          'SELECT tenant_id, holiday_date, name FROM holiday',
        );
        return rows.map(
          (r: Row): Holiday => ({ tenantId: r.tenant_id, date: r.holiday_date, name: r.name }),
        );
      }),
  };

  readonly leaves: LeaveRepository = {
    findLeaveType: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, code, name, is_paid, deducts_from_balance, balance_source
             FROM leave_type WHERE id = $1`,
          [id],
        );
        const r = rows[0];
        return r === undefined
          ? null
          : ({
              id: r.id,
              tenantId: r.tenant_id,
              code: r.code,
              name: r.name,
              isPaid: r.is_paid,
              deductsFromBalance: r.deducts_from_balance,
              balanceSource: r.balance_source,
            } satisfies LeaveType);
      }),
    listGrants: async (memberId) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(GRANT_SELECT + ' WHERE member_id = $1', [memberId]);
        return rows.map(toGrant);
      }),
    saveGrants: async (grants) => {
      if (grants.length === 0) return;
      await this.db.withTenant(async (c) => {
        for (const g of grants) {
          await c.query(
            `INSERT INTO leave_grant (id, tenant_id, member_id, balance_source, grant_reason,
                                      granted_units, used_units, expired_units,
                                      effective_from, expires_at, grant_basis)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (id) DO UPDATE
               SET granted_units = EXCLUDED.granted_units,
                   used_units    = EXCLUDED.used_units,
                   expired_units = EXCLUDED.expired_units`,
            [
              g.id, g.tenantId, g.memberId, g.balanceSource, g.reason,
              g.grantedUnits, g.usedUnits, g.expiredUnits,
              g.effectiveFrom, g.expiresAt, JSON.stringify(g.basis),
            ],
          );
        }
      });
    },
    insertRequest: async (request, deductions) =>
      this.db.withTenant(async (c) => {
        await c.query(
          `INSERT INTO leave_request (id, tenant_id, member_id, leave_type_id,
                                      start_date, end_date, units, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            request.id, request.tenantId, request.memberId, request.leaveTypeId,
            request.startDate, request.endDate, request.units, request.reason, request.status,
          ],
        );
        for (const d of deductions) {
          await c.query(
            `INSERT INTO leave_deduction (tenant_id, leave_request_id, leave_grant_id, units)
             VALUES ($1,$2,$3,$4)`,
            [request.tenantId, request.id, d.grantId, d.units],
          );
        }
        return request;
      }),
    findRequest: async (id) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(REQUEST_SELECT + ' WHERE r.id = $1 GROUP BY r.id', [id]);
        return rows[0] === undefined ? null : toRequest(rows[0]);
      }),
    setRequestStatus: async (id, status) => {
      await this.db.withTenant(async (c) => {
        await c.query('UPDATE leave_request SET status = $2 WHERE id = $1', [id, status]);
      });
    },
    listRequestsByMember: async (memberId) =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          REQUEST_SELECT + ' WHERE r.member_id = $1 GROUP BY r.id ORDER BY r.start_date DESC',
          [memberId],
        );
        return rows.map(toRequest);
      }),
    listOverlappingRequests: async (memberIds, from, to) =>
      memberIds.length === 0
        ? []
        : this.db.withTenant(async (c) => {
            const { rows } = await c.query(
              REQUEST_SELECT +
                ` WHERE r.member_id = ANY($1::uuid[])
                    AND r.status NOT IN ('CANCELLED','REJECTED')
                    AND r.start_date <= $3 AND r.end_date >= $2
                  GROUP BY r.id`,
              [memberIds, from, to],
            );
            return rows.map(toRequest);
          }),
  };

  readonly audit: AuditRepository = {
    append: async (entry) => {
      await this.db.withTenant(async (c) => {
        await c.query(
          `INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, entity_type, entity_id, reason)
           VALUES ($1,$2,'MEMBER',$3,$4,$5,$6)`,
          [tenantId(), entry.actorId, entry.action, entry.entityType, entry.entityId, entry.reason],
        );
      });
    },
    list: async () =>
      this.db.withTenant(async (c) => {
        const { rows } = await c.query(
          `SELECT id, tenant_id, actor_id, action, entity_type, entity_id, reason, occurred_at
             FROM audit_log ORDER BY id`,
        );
        return rows.map(
          (r: Row): AuditLogEntry => ({
            id: String(r.id),
            tenantId: r.tenant_id,
            actorId: r.actor_id,
            action: r.action,
            entityType: r.entity_type,
            entityId: r.entity_id,
            reason: r.reason,
            occurredAt: r.occurred_at,
          }),
        );
      }),
  };
}

// --- 매핑 헬퍼 --------------------------------------------------------------

const MEMBER_SELECT = `
  SELECT id, tenant_id, employee_no, name, worksite_id, department_id,
         job_family, employment_type, hire_date, status
    FROM member`;

const ATTENDANCE_SELECT = `
  SELECT id, tenant_id, member_id, work_date, record_type, captured_at, received_at,
         verification, verify_method, confidence, worksite_id, reason, evidence,
         source, client_nonce, is_superseded
    FROM attendance_record`;

const GRANT_SELECT = `
  SELECT id, tenant_id, member_id, balance_source, grant_reason,
         granted_units, used_units, expired_units, effective_from, expires_at, grant_basis
    FROM leave_grant`;

const REQUEST_SELECT = `
  SELECT r.id, r.tenant_id, r.member_id, r.leave_type_id, r.start_date, r.end_date,
         r.units, r.reason, r.status,
         COALESCE(
           json_agg(json_build_object('grantId', d.leave_grant_id, 'units', d.units))
             FILTER (WHERE d.id IS NOT NULL),
           '[]'
         ) AS deductions
    FROM leave_request r
    LEFT JOIN leave_deduction d ON d.leave_request_id = r.id`;

function toMember(r: Row): Member {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    employeeNo: r['employee_no'] as string,
    name: r['name'] as string,
    worksiteId: r['worksite_id'] as string,
    departmentId: r['department_id'] as string,
    jobFamily: r['job_family'] as Member['jobFamily'],
    employmentType: r['employment_type'] as Member['employmentType'],
    hireDate: r['hire_date'] as LocalDate,
    status: r['status'] as Member['status'],
  };
}

function toAttendance(r: Row): AttendanceRecord {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    memberId: r['member_id'] as string,
    workDate: r['work_date'] as LocalDate,
    recordType: r['record_type'] as AttendanceRecord['recordType'],
    capturedAt: r['captured_at'] as Date,
    receivedAt: r['received_at'] as Date,
    verification: r['verification'] as AttendanceRecord['verification'],
    verifyMethod: r['verify_method'] as AttendanceRecord['verifyMethod'],
    confidence: r['confidence'] as AttendanceRecord['confidence'],
    worksiteId: r['worksite_id'] as string | null,
    reason: r['reason'] as string | null,
    evidence: r['evidence'] as Record<string, unknown>,
    source: r['source'] as AttendanceRecord['source'],
    clientNonce: r['client_nonce'] as string | null,
    isSuperseded: r['is_superseded'] as boolean,
  };
}

function toGrant(r: Row): TenantLeaveGrant {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    memberId: r['member_id'] as string,
    balanceSource: r['balance_source'] as TenantLeaveGrant['balanceSource'],
    reason: r['grant_reason'] as TenantLeaveGrant['reason'],
    grantedUnits: r['granted_units'] as number,
    usedUnits: r['used_units'] as number,
    expiredUnits: r['expired_units'] as number,
    effectiveFrom: r['effective_from'] as LocalDate,
    expiresAt: r['expires_at'] as LocalDate,
    basis: r['grant_basis'] as Record<string, unknown>,
  };
}

function toRequest(r: Row): LeaveRequest {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    memberId: r['member_id'] as string,
    leaveTypeId: r['leave_type_id'] as string,
    startDate: r['start_date'] as LocalDate,
    endDate: r['end_date'] as LocalDate,
    units: r['units'] as number,
    reason: r['reason'] as string | null,
    status: r['status'] as LeaveRequest['status'],
    deductions: r['deductions'] as { grantId: string; units: number }[],
  };
}

export type { PoolClient };
