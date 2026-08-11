export type ClockInLocation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  capturedAt: string;
};

type GeolocationReader = Pick<Geolocation, "getCurrentPosition">;

export const CLOCK_IN_LOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15_000,
};

/**
 * Some Android devices time out while waiting for a dedicated GPS fix indoors.
 * Retry once with network-assisted positioning, but still require a new sample
 * (`maximumAge: 0`) and never start a background watcher.
 */
export const CLOCK_IN_LOCATION_FALLBACK_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 0,
  timeout: 20_000,
};

function geolocationErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return 0;
  const value = error as { code?: unknown; name?: unknown };
  const numericCode = Number(value.code);
  if (numericCode === 1 || numericCode === 2 || numericCode === 3) return numericCode;
  if (value.name === "SecurityError" || value.name === "NotAllowedError") return 1;
  return 0;
}

function friendlyGeolocationError(error: unknown) {
  const code = geolocationErrorCode(error);
  if (code === 0 && error instanceof Error && error.message) return error;
  return new Error(attendanceLocationErrorMessage(code));
}

export function attendanceLocationErrorMessage(code: number) {
  if (code === 1) {
    return "Trang web chưa được phép dùng Vị trí. Trên điện thoại, hãy mở Quyền của trang doregroup.io.vn, chọn Vị trí → Cho phép, tải lại trang rồi bấm Điểm danh.";
  }
  if (code === 2) {
    return "Không thể xác định vị trí hiện tại. Hãy bật GPS hoặc Wi-Fi, di chuyển đến nơi có tín hiệu tốt rồi thử lại.";
  }
  if (code === 3) {
    return "Quá thời gian lấy vị trí. Hãy bật GPS, kiểm tra tín hiệu rồi bấm Điểm danh lại.";
  }
  return "Không thể lấy vị trí hiện tại. Vui lòng kiểm tra quyền Vị trí và thử lại.";
}

/**
 * Capture exactly one fresh location sample for a clock-in confirmation.
 * This deliberately takes a single reading, so closing or declining the
 * confirmation cannot leave any background tracking active.
 */
export function captureClockInLocation(
  geolocation: GeolocationReader | null = typeof navigator !== "undefined" ? navigator.geolocation : null,
  now: () => number = Date.now,
  secureContext: boolean = typeof window === "undefined" || window.isSecureContext,
): Promise<ClockInLocation> {
  if (!secureContext) {
    return Promise.reject(new Error(
      "Trình duyệt chỉ cho phép lấy vị trí trên kết nối HTTPS an toàn. Vui lòng mở https://doregroup.io.vn rồi thử lại.",
    ));
  }
  if (!geolocation) {
    return Promise.reject(new Error(
      "Thiết bị hoặc trình duyệt không hỗ trợ định vị. Vui lòng dùng trình duyệt có hỗ trợ và bật dịch vụ vị trí.",
    ));
  }

  const readPosition = (options: PositionOptions) => new Promise<ClockInLocation>((resolve, reject) => {
    geolocation.getCurrentPosition((position) => {
      const latitude = Number(position.coords.latitude);
      const longitude = Number(position.coords.longitude);
      const accuracyMeters = Number(position.coords.accuracy);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
        || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
        || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) {
        reject(new Error("Vị trí nhận được không hợp lệ. Vui lòng bật lại GPS và bấm Điểm danh lại."));
        return;
      }
      resolve({
        latitude,
        longitude,
        accuracyMeters,
        capturedAt: new Date(now()).toISOString(),
      });
    }, reject, options);
  });

  return readPosition(CLOCK_IN_LOCATION_OPTIONS).catch(async (firstError: unknown) => {
    const firstCode = geolocationErrorCode(firstError);
    if (firstCode !== 2 && firstCode !== 3) {
      throw friendlyGeolocationError(firstError);
    }
    try {
      return await readPosition(CLOCK_IN_LOCATION_FALLBACK_OPTIONS);
    } catch (fallbackError) {
      throw friendlyGeolocationError(fallbackError);
    }
  });
}

export const CLOCK_IN_LOCATION_MAX_AGE_MS = 5 * 60 * 1000;
export const CLOCK_IN_LOCATION_MAX_FUTURE_SKEW_MS = 60 * 1000;
export const CLOCK_IN_LOCATION_MAX_ACCURACY_METERS = 100_000;

export type ClockInLocationValidation =
  | { ok: true; location: ClockInLocation }
  | { ok: false; code: "LOCATION_REQUIRED" | "LOCATION_INVALID" | "LOCATION_STALE"; message: string };

/**
 * Validate a one-time browser snapshot against the server receipt time.
 * capturedAt only proves freshness; started_at remains the official server time.
 */
export function validateClockInLocation(input: unknown, serverNowIso: string): ClockInLocationValidation {
  if (input === null || input === undefined) {
    return {
      ok: false,
      code: "LOCATION_REQUIRED",
      message: "Vui lòng bật định vị và cho phép truy cập vị trí để điểm danh.",
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "LOCATION_INVALID", message: "Dữ liệu vị trí điểm danh không hợp lệ." };
  }

  const value = input as Record<string, unknown>;
  const latitude = value.latitude;
  const longitude = value.longitude;
  const accuracyMeters = value.accuracyMeters;
  const capturedAt = value.capturedAt;
  if (
    typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180
    || typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters)
    || accuracyMeters < 0 || accuracyMeters > CLOCK_IN_LOCATION_MAX_ACCURACY_METERS
    || typeof capturedAt !== "string"
  ) {
    return { ok: false, code: "LOCATION_INVALID", message: "Dữ liệu vị trí điểm danh không hợp lệ." };
  }

  const serverNow = Date.parse(serverNowIso);
  const capturedTime = Date.parse(capturedAt);
  if (!Number.isFinite(serverNow) || !Number.isFinite(capturedTime)) {
    return { ok: false, code: "LOCATION_INVALID", message: "Thời gian lấy vị trí không hợp lệ." };
  }
  const ageMs = serverNow - capturedTime;
  if (ageMs > CLOCK_IN_LOCATION_MAX_AGE_MS || ageMs < -CLOCK_IN_LOCATION_MAX_FUTURE_SKEW_MS) {
    return {
      ok: false,
      code: "LOCATION_STALE",
      message: "Vị trí đã quá cũ. Vui lòng lấy lại vị trí hiện tại rồi điểm danh.",
    };
  }

  return {
    ok: true,
    location: {
      latitude,
      longitude,
      accuracyMeters,
      capturedAt: new Date(capturedTime).toISOString(),
    },
  };
}
