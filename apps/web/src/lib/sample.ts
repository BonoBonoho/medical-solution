/**
 * API 없이 그리드를 볼 수 있게 하는 샘플 근무표.
 *
 * 실제 API가 떠 있으면 그쪽 데이터를 쓴다. 이 데이터는 **화면을 확인하기
 * 위한 것**이지 시연용 미끼가 아니어서, 실제 병동에서 나오는 것과 같은
 * 종류의 위반(연속 나이트, 퀵리턴, 주 52시간 초과)이 들어 있다.
 */

import {
  addDays,
  ruleSetsWithHealthcareException,
  type IdentifiedShiftType,
  type LocalDate,
  type PlannedAssignment,
  type RosterPlan,
  type RuleMember,
} from '@mediwork/domain';

const WORKSITE = 'sample-worksite';
export const PERIOD_START: LocalDate = '2026-08-03';
export const PERIOD_END: LocalDate = '2026-08-30';

export const SAMPLE_SHIFT_TYPES: IdentifiedShiftType[] = [
  {
    id: 'st-d',
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
    id: 'st-e',
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
    id: 'st-n',
    code: 'N',
    name: '나이트',
    category: 'WORK',
    startTime: '22:00',
    endTime: '08:00',
    breakMinutes: 120,
    paidMinutesOverride: null,
    countsAsWork: true,
    dutyMode: null,
    dutyRatio: null,
    isNight: true,
  },
  {
    id: 'st-o',
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
    id: 'st-v',
    code: 'V',
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
];

export const CODE_BY_SHIFT_TYPE_ID = new Map(
  SAMPLE_SHIFT_TYPES.map((s) => [s.id, s.code]),
);
export const SHIFT_TYPE_ID_BY_CODE = new Map(
  SAMPLE_SHIFT_TYPES.map((s) => [s.code, s.id]),
);

const NAMES = [
  '김간호',
  '박수간',
  '이보람',
  '최민지',
  '정하늘',
  '강서연',
  '윤지호',
  '임채원',
  '한도윤',
  '오세진',
  '서예린',
  '노태경',
];

export const SAMPLE_MEMBERS: RuleMember[] = NAMES.map((name, i) => ({
  id: `m${i + 1}`,
  name,
  worksiteId: WORKSITE,
  jobFamily: 'NURSE',
  employmentType: 'REGULAR',
}));

/**
 * 3교대 순환 패턴. 사람마다 위상을 어긋나게 해서 매일 D/E/N이 채워지게 한다.
 *
 * 위반이 나오도록 일부러 이렇게 짰다. 인력이 빠듯한 병동에서 실제로 나오는
 * 형태다.
 *   · `E → D` — 이브닝 23:00 종료 후 데이 07:00 시작. 휴식 8시간.
 *     금지 패턴(BLOCK)과 11시간 연속휴식 위반(BLOCK)에 동시에 걸린다.
 *   · 나이트 4연속 — 권장 상한 3회 초과(WARN).
 *
 * 위반이 하나도 없는 샘플은 그리드가 제대로 도는지 확인할 수 없게 만든다.
 */
const CYCLE = ['D', 'D', 'E', 'D', 'N', 'N', 'N', 'N', 'O'] as const;

function buildAssignments(): PlannedAssignment[] {
  const assignments: PlannedAssignment[] = [];
  for (const [memberIndex, member] of SAMPLE_MEMBERS.entries()) {
    let date = PERIOD_START;
    let day = 0;
    while (date <= PERIOD_END) {
      const code = CYCLE[(day + memberIndex * 2) % CYCLE.length]!;
      assignments.push({
        id: `a-${member.id}-${date}`,
        memberId: member.id,
        workDate: date,
        shiftTypeId: SHIFT_TYPE_ID_BY_CODE.get(code)!,
      });
      date = addDays(date, 1);
      day += 1;
    }
  }
  return assignments;
}

export const SAMPLE_PLAN: RosterPlan = {
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  members: SAMPLE_MEMBERS,
  shiftTypes: SAMPLE_SHIFT_TYPES,
  assignments: buildAssignments(),
  holidays: ['2026-08-15'], // 광복절
  // 특례 서면합의가 있는 사업장. 52시간 한도 대신 11시간 연속휴식이 적용된다.
  ruleSetsByWorksite: {
    [WORKSITE]: ruleSetsWithHealthcareException(WORKSITE, '2026-01-01', '2026-12-31'),
  },
  basis: 'PLANNED',
};
