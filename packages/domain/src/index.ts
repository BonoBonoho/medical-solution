/**
 * @mediwork/domain
 *
 * 근로시간 산정·규칙 평가·연차 산정·위치 검증의 단일 진실 공급원.
 * 서버·웹·모바일이 모두 이 패키지를 사용한다. 계산 로직이 세 벌로 갈라지는 것이
 * 이 도메인에서 가장 흔한 사고다. (docs/03-architecture.md §8.1)
 *
 * 모든 export는 부수효과가 없는 순수 함수와 타입이다.
 */

export * from './time/interval.js';
export * from './time/shift.js';

export * from './worktime/daily.js';
export * from './worktime/weekly.js';

export * from './rules/types.js';
export * from './rules/engine.js';
export { EVALUATORS } from './rules/evaluators.js';
export * from './rules/presets.js';

export * from './roster/evaluate.js';

export * from './leave/units.js';
export * from './leave/accrual.js';
export * from './leave/ledger.js';

export * from './attendance/verify.js';
