/**
 * Anchor a browser event to an authenticated server timestamp without using
 * the device wall clock. performance.now() supplies only the elapsed duration.
 */
export function serverAnchoredClockInCapturedAt(serverNowIso: string, elapsedSinceCaptureMs: number) {
  const serverNow = Date.parse(serverNowIso);
  if (!Number.isFinite(serverNow) || !Number.isFinite(elapsedSinceCaptureMs)) return null;
  const capturedAt = serverNow - Math.max(0, elapsedSinceCaptureMs);
  if (!Number.isFinite(capturedAt)) return null;
  return new Date(capturedAt).toISOString();
}
