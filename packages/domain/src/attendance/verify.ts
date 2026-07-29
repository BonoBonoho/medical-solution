/**
 * 출퇴근 위치 검증.
 *
 * 우선순위: 편의성 > 프라이버시 > 정확성.
 * 정확성을 최우선에 두면 검증이 엄격해지고, 정상 출근인데 실패하는 경우가 늘고,
 * 그러면 사용자가 시스템 밖에서 일하게 된다. 시스템 밖으로 나간 기록은
 * 정확성이 0이다. (docs/06-mobile-attendance.md §1)
 */

export type Verification = 'VERIFIED' | 'PENDING_REVIEW' | 'REJECTED';
export type VerifyMethod = 'WIFI' | 'GPS' | 'BEACON' | 'NFC' | 'IP' | 'KIOSK' | 'MANUAL';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export interface GpsReading {
  readonly lat: number;
  readonly lng: number;
  /** 미터 단위 정확도. */
  readonly accuracy: number;
  readonly isMock: boolean;
}

export interface WifiReading {
  /** AP의 MAC 주소. SSID는 이름일 뿐이라 위조가 쉬우므로 BSSID로 검증한다. */
  readonly bssid: string;
  readonly rssi?: number;
}

export interface Geofence {
  readonly id: string;
  readonly name: string;
  readonly worksiteId: string;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly radiusM: number;
  readonly isActive: boolean;
}

export interface WifiAccessPoint {
  readonly bssid: string;
  readonly worksiteId: string;
  readonly label?: string;
  readonly isActive: boolean;
}

export interface DeviceIntegrity {
  /** Play Integrity / App Attest 검증 통과 여부. */
  readonly verified: boolean;
  /** 등록된 기기인가. */
  readonly bound: boolean;
}

export interface VerifyLocationInput {
  readonly gps?: GpsReading;
  readonly wifi?: readonly WifiReading[];
  readonly integrity?: DeviceIntegrity;
  /** 기기 캡처 시각과 서버 수신 시각의 차이(분). 오프라인 큐 지연 판정용. */
  readonly captureDelayMinutes?: number;
}

export interface VerifyLocationConfig {
  readonly geofences: readonly Geofence[];
  readonly accessPoints: readonly WifiAccessPoint[];
  /** GPS 정확도가 이 값을 넘으면 신뢰하지 않는다. 기본 100m. */
  readonly maxGpsAccuracyM?: number;
  /** 이 시간을 넘겨 도착한 오프라인 기록은 승인 대기로 돌린다. 기본 4시간. */
  readonly maxCaptureDelayMinutes?: number;
}

export interface VerifyLocationResult {
  readonly verification: Verification;
  readonly method: VerifyMethod | null;
  readonly confidence: Confidence | null;
  readonly worksiteId: string | null;
  /** 승인 대기·거부 사유 코드. */
  readonly reason: string | null;
  /** 사용자에게 보여줄 한국어 설명. 무엇이 왜 실패했는지 구체적으로 말한다. */
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/** 두 좌표 사이의 거리(m). Haversine. */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function normalizeBssid(bssid: string): string {
  return bssid.trim().toLowerCase().replace(/-/g, ':');
}

/**
 * 위치를 검증한다.
 *
 * 검증 순서
 *   ① WiFi BSSID 매칭 → confidence HIGH
 *   ② GPS 지오펜스     → confidence MEDIUM
 *   ③ 실패             → PENDING_REVIEW (기록은 저장하되 관리자 확인 필요)
 *
 * 검증에 실패해도 REJECTED로 만들지 않는다. 거부하고 버리면 직원은 출근했는데
 * 기록이 없는 상태가 되고, 그건 병원 책임 문제가 된다.
 */
export function verifyLocation(
  input: VerifyLocationInput,
  config: VerifyLocationConfig,
): VerifyLocationResult {
  const {
    geofences,
    accessPoints,
    maxGpsAccuracyM = 100,
    maxCaptureDelayMinutes = 240,
  } = config;

  const delayed =
    input.captureDelayMinutes !== undefined &&
    input.captureDelayMinutes > maxCaptureDelayMinutes;

  // ① WiFi BSSID
  const activeAps = new Map(
    accessPoints.filter((ap) => ap.isActive).map((ap) => [normalizeBssid(ap.bssid), ap]),
  );
  for (const reading of input.wifi ?? []) {
    const matched = activeAps.get(normalizeBssid(reading.bssid));
    if (matched === undefined) continue;
    return finalize(
      {
        verification: 'VERIFIED',
        method: 'WIFI',
        confidence: 'HIGH',
        worksiteId: matched.worksiteId,
        reason: null,
        message: `병원 WiFi(${matched.label ?? matched.bssid})가 확인되어 기록되었습니다.`,
        detail: { matchedBssid: matched.bssid, label: matched.label },
      },
      input,
      delayed,
    );
  }

  // ② GPS 지오펜스
  const gps = input.gps;
  if (gps !== undefined) {
    if (gps.isMock) {
      return {
        verification: 'PENDING_REVIEW',
        method: 'GPS',
        confidence: 'LOW',
        worksiteId: null,
        reason: 'MOCK_LOCATION',
        message:
          '기기에서 모의 위치가 감지되어 자동 승인되지 않았습니다. 관리자 확인 후 반영됩니다.',
        detail: { isMock: true },
      };
    }

    if (gps.accuracy > maxGpsAccuracyM) {
      return {
        verification: 'PENDING_REVIEW',
        method: 'GPS',
        confidence: 'LOW',
        worksiteId: null,
        reason: 'GPS_ACCURACY_LOW',
        message:
          `GPS 정확도가 ${Math.round(gps.accuracy)}m로 낮아 자동 승인되지 않았습니다. ` +
          '병원 WiFi에 연결하면 실내에서도 정확하게 기록됩니다.',
        detail: { accuracy: gps.accuracy, threshold: maxGpsAccuracyM },
      };
    }

    let nearest: { fence: Geofence; distance: number } | null = null;
    for (const fence of geofences) {
      if (!fence.isActive) continue;
      const distance = haversineMeters(gps.lat, gps.lng, fence.centerLat, fence.centerLng);
      if (nearest === null || distance < nearest.distance) nearest = { fence, distance };
    }

    if (nearest !== null && nearest.distance <= nearest.fence.radiusM) {
      return finalize(
        {
          verification: 'VERIFIED',
          method: 'GPS',
          confidence: 'MEDIUM',
          worksiteId: nearest.fence.worksiteId,
          reason: null,
          message: `${nearest.fence.name} 반경 내에서 기록되었습니다.`,
          detail: {
            geofenceId: nearest.fence.id,
            distanceM: Math.round(nearest.distance),
            radiusM: nearest.fence.radiusM,
          },
        },
        input,
        delayed,
      );
    }

    return {
      verification: 'PENDING_REVIEW',
      method: 'GPS',
      confidence: 'LOW',
      worksiteId: null,
      reason: 'GEOFENCE_OUT',
      message:
        nearest === null
          ? '등록된 사업장 위치가 없어 자동 승인되지 않았습니다. 관리자 확인 후 반영됩니다.'
          : `병원에서 ${Math.round(nearest.distance)}m 떨어진 위치로 확인되어 ` +
            '자동 승인되지 않았습니다. 승인 요청으로 기록됩니다.',
      detail:
        nearest === null
          ? {}
          : { distanceM: Math.round(nearest.distance), radiusM: nearest.fence.radiusM },
    };
  }

  return {
    verification: 'PENDING_REVIEW',
    method: null,
    confidence: null,
    worksiteId: null,
    reason: 'NO_LOCATION_SIGNAL',
    message:
      '위치를 확인할 수 있는 정보가 없어 자동 승인되지 않았습니다. ' +
      '병원 WiFi 연결 또는 위치 권한 허용 후 다시 시도하거나, 승인 요청으로 기록해 주세요.',
    detail: {},
  };
}

/**
 * 무결성 검증 실패나 지연 도착은 **거부가 아니라 강등**으로 처리한다.
 * 커스텀 ROM, 오래된 기기, 일시적 서비스 장애로도 실패할 수 있고,
 * 이런 사람들의 출근을 막으면 안 된다.
 */
function finalize(
  result: VerifyLocationResult,
  input: VerifyLocationInput,
  delayed: boolean,
): VerifyLocationResult {
  const integrity = input.integrity;

  if (integrity !== undefined && !integrity.bound) {
    return {
      ...result,
      verification: 'PENDING_REVIEW',
      confidence: 'LOW',
      reason: 'DEVICE_NOT_BOUND',
      message: '등록되지 않은 기기에서 기록되어 관리자 확인이 필요합니다.',
    };
  }

  if (integrity !== undefined && !integrity.verified) {
    return {
      ...result,
      verification: 'PENDING_REVIEW',
      confidence: 'LOW',
      reason: 'INTEGRITY_UNVERIFIED',
      message: '기기 무결성 확인에 실패하여 관리자 확인이 필요합니다. 기록은 저장되었습니다.',
    };
  }

  if (delayed) {
    return {
      ...result,
      verification: 'PENDING_REVIEW',
      confidence: 'LOW',
      reason: 'DELAYED_ARRIVAL',
      message:
        '오프라인 상태에서 기록된 후 전송이 지연되어 관리자 확인이 필요합니다. ' +
        '기록은 저장되었습니다.',
      detail: { ...result.detail, captureDelayMinutes: input.captureDelayMinutes },
    };
  }

  return result;
}

export interface TravelCheckInput {
  readonly previousLat: number;
  readonly previousLng: number;
  readonly previousAt: Date;
  readonly currentLat: number;
  readonly currentLng: number;
  readonly currentAt: Date;
}

export interface TravelCheckResult {
  readonly impossible: boolean;
  readonly distanceM: number;
  readonly elapsedMinutes: number;
  readonly speedKmh: number;
}

/**
 * 물리적으로 불가능한 이동을 탐지한다.
 *
 * 앱 조작 여부와 무관하게 서버에서 판정할 수 있어 실용적이다.
 * 단, 이 신호는 **의심일 뿐 증거가 아니다.** UI에서 "부정 출근"으로 단정하는
 * 표현을 쓰면 안 된다. (docs/06-mobile-attendance.md §8)
 */
export function checkImpossibleTravel(
  input: TravelCheckInput,
  maxSpeedKmh = 150,
): TravelCheckResult {
  const distanceM = haversineMeters(
    input.previousLat,
    input.previousLng,
    input.currentLat,
    input.currentLng,
  );
  const elapsedMinutes = (input.currentAt.getTime() - input.previousAt.getTime()) / 60_000;

  if (elapsedMinutes <= 0) {
    return { impossible: distanceM > 0, distanceM, elapsedMinutes, speedKmh: Infinity };
  }

  const speedKmh = distanceM / 1000 / (elapsedMinutes / 60);
  return { impossible: speedKmh > maxSpeedKmh, distanceM, elapsedMinutes, speedKmh };
}
