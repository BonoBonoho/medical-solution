import { describe, expect, it } from 'vitest';
import {
  checkImpossibleTravel,
  haversineMeters,
  verifyLocation,
  type VerifyLocationConfig,
} from '../src/index.js';

// 서울아산병원 인근 좌표를 예시로 사용한다.
const HOSPITAL_LAT = 37.5268;
const HOSPITAL_LNG = 127.1085;

const config: VerifyLocationConfig = {
  geofences: [
    {
      id: 'gf1',
      name: '본원',
      worksiteId: 'w1',
      centerLat: HOSPITAL_LAT,
      centerLng: HOSPITAL_LNG,
      radiusM: 200,
      isActive: true,
    },
  ],
  accessPoints: [
    { bssid: 'A4:2B:8C:11:22:33', worksiteId: 'w1', label: '3층 간호사실', isActive: true },
    { bssid: 'a4:2b:8c:11:22:34', worksiteId: 'w1', isActive: false },
  ],
};

describe('거리 계산', () => {
  it('같은 좌표는 0m', () => {
    expect(haversineMeters(HOSPITAL_LAT, HOSPITAL_LNG, HOSPITAL_LAT, HOSPITAL_LNG)).toBe(0);
  });

  it('위도 1도는 약 111km', () => {
    const d = haversineMeters(37, 127, 38, 127);
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('WiFi 검증 (우선순위 1)', () => {
  it('BSSID가 매칭되면 HIGH 신뢰도로 승인한다', () => {
    const result = verifyLocation({ wifi: [{ bssid: 'a4:2b:8c:11:22:33' }] }, config);
    expect(result.verification).toBe('VERIFIED');
    expect(result.method).toBe('WIFI');
    expect(result.confidence).toBe('HIGH');
    expect(result.worksiteId).toBe('w1');
    expect(result.message).toContain('3층 간호사실');
  });

  it('대소문자와 구분자를 정규화한다', () => {
    const result = verifyLocation({ wifi: [{ bssid: 'A4-2B-8C-11-22-33' }] }, config);
    expect(result.verification).toBe('VERIFIED');
  });

  it('비활성 AP는 매칭하지 않는다', () => {
    const result = verifyLocation({ wifi: [{ bssid: 'a4:2b:8c:11:22:34' }] }, config);
    expect(result.verification).toBe('PENDING_REVIEW');
  });

  it('GPS가 실패해도 WiFi가 맞으면 승인한다 — 실내에서 GPS는 신뢰할 수 없다', () => {
    const result = verifyLocation(
      {
        wifi: [{ bssid: 'a4:2b:8c:11:22:33' }],
        gps: { lat: 37.6, lng: 127.2, accuracy: 800, isMock: false },
      },
      config,
    );
    expect(result.verification).toBe('VERIFIED');
    expect(result.method).toBe('WIFI');
  });
});

describe('GPS 검증 (우선순위 2)', () => {
  it('지오펜스 내면 MEDIUM 신뢰도로 승인한다', () => {
    const result = verifyLocation(
      { gps: { lat: HOSPITAL_LAT, lng: HOSPITAL_LNG, accuracy: 15, isMock: false } },
      config,
    );
    expect(result.verification).toBe('VERIFIED');
    expect(result.method).toBe('GPS');
    expect(result.confidence).toBe('MEDIUM');
  });

  it('지오펜스 밖이면 거리와 함께 승인 대기로 처리한다', () => {
    const result = verifyLocation(
      { gps: { lat: 37.5300, lng: 127.1085, accuracy: 15, isMock: false } },
      config,
    );
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('GEOFENCE_OUT');
    expect(result.detail['distanceM']).toBeGreaterThan(200);
    // 무엇이 왜 실패했는지 구체적으로 말한다
    expect(result.message).toMatch(/\d+m 떨어진/);
  });

  it('모의 위치는 승인하지 않되 기록은 남긴다', () => {
    const result = verifyLocation(
      { gps: { lat: HOSPITAL_LAT, lng: HOSPITAL_LNG, accuracy: 5, isMock: true } },
      config,
    );
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('MOCK_LOCATION');
    // REJECTED가 아니다 — 거부하고 버리면 출근했는데 기록이 없는 상태가 된다
    expect(result.verification).not.toBe('REJECTED');
  });

  it('정확도가 낮으면 WiFi 연결을 안내한다', () => {
    const result = verifyLocation(
      { gps: { lat: HOSPITAL_LAT, lng: HOSPITAL_LNG, accuracy: 500, isMock: false } },
      config,
    );
    expect(result.reason).toBe('GPS_ACCURACY_LOW');
    expect(result.message).toContain('병원 WiFi');
  });
});

describe('위치 신호 없음', () => {
  it('승인 대기로 처리하고 대체 수단을 안내한다', () => {
    const result = verifyLocation({}, config);
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('NO_LOCATION_SIGNAL');
    expect(result.message).toContain('승인 요청');
  });
});

describe('기기 무결성 — 거부가 아니라 강등', () => {
  it('미등록 기기는 승인 대기로 강등한다', () => {
    const result = verifyLocation(
      {
        wifi: [{ bssid: 'a4:2b:8c:11:22:33' }],
        integrity: { verified: true, bound: false },
      },
      config,
    );
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('DEVICE_NOT_BOUND');
  });

  it('무결성 검증 실패는 강등하되 기록은 남긴다', () => {
    const result = verifyLocation(
      {
        wifi: [{ bssid: 'a4:2b:8c:11:22:33' }],
        integrity: { verified: false, bound: true },
      },
      config,
    );
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('INTEGRITY_UNVERIFIED');
    expect(result.message).toContain('기록은 저장');
  });

  it('무결성 통과 + 등록 기기면 그대로 승인한다', () => {
    const result = verifyLocation(
      {
        wifi: [{ bssid: 'a4:2b:8c:11:22:33' }],
        integrity: { verified: true, bound: true },
      },
      config,
    );
    expect(result.verification).toBe('VERIFIED');
  });
});

describe('오프라인 큐 지연 도착', () => {
  it('임계값 이내면 승인한다', () => {
    const result = verifyLocation(
      { wifi: [{ bssid: 'a4:2b:8c:11:22:33' }], captureDelayMinutes: 30 },
      config,
    );
    expect(result.verification).toBe('VERIFIED');
  });

  it('4시간을 넘겨 도착하면 승인 대기로 처리한다', () => {
    const result = verifyLocation(
      { wifi: [{ bssid: 'a4:2b:8c:11:22:33' }], captureDelayMinutes: 300 },
      config,
    );
    expect(result.verification).toBe('PENDING_REVIEW');
    expect(result.reason).toBe('DELAYED_ARRIVAL');
    expect(result.detail['captureDelayMinutes']).toBe(300);
  });
});

describe('물리적으로 불가능한 이동 탐지', () => {
  it('30분 만에 서울→부산은 불가능하다', () => {
    const result = checkImpossibleTravel({
      previousLat: 37.5665,
      previousLng: 126.978,
      previousAt: new Date('2026-07-29T00:00:00Z'),
      currentLat: 35.1796,
      currentLng: 129.0756,
      currentAt: new Date('2026-07-29T00:30:00Z'),
    });
    expect(result.impossible).toBe(true);
    expect(result.speedKmh).toBeGreaterThan(500);
  });

  it('정상적인 통근 이동은 통과한다', () => {
    const result = checkImpossibleTravel({
      previousLat: 37.5665,
      previousLng: 126.978,
      previousAt: new Date('2026-07-29T00:00:00Z'),
      currentLat: 37.5268,
      currentLng: 127.1085,
      currentAt: new Date('2026-07-29T00:40:00Z'),
    });
    expect(result.impossible).toBe(false);
  });

  it('같은 시각의 다른 위치는 불가능으로 본다', () => {
    const at = new Date('2026-07-29T00:00:00Z');
    const result = checkImpossibleTravel({
      previousLat: 37.5665,
      previousLng: 126.978,
      previousAt: at,
      currentLat: 35.1796,
      currentLng: 129.0756,
      currentAt: at,
    });
    expect(result.impossible).toBe(true);
  });
});
