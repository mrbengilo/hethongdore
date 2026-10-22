/**
 * A response may update UI state only while it is both the newest request and
 * still live. Keeping this predicate pure makes stale/aborted behavior easy to
 * regression-test without a browser runtime.
 */
export function requestIsCurrent(requestId: number, latestRequestId: number, aborted: boolean) {
  return requestId === latestRequestId && !aborted;
}
