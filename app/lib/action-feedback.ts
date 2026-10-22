export type ActionNotice = { kind: "success" | "error"; message: string };
const listeners = new Set<(notice: ActionNotice) => void>();

export function subscribeActionFeedback(listener: (notice: ActionNotice) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyAction(message: string, kind: ActionNotice["kind"] = "success") {
  for (const listener of listeners) listener({ message, kind });
}

export function runExclusiveAction(
  gate: { current: boolean }, action: () => unknown,
  onPending: (pending: boolean) => void, onError: (error: unknown) => void,
): Promise<void> | void {
  if (gate.current) return;
  gate.current = true;
  try {
    const result = action();
    if (result && typeof (result as PromiseLike<unknown>).then === "function") {
      onPending(true);
      return Promise.resolve(result).then(() => {}, onError).finally(() => {
        gate.current = false;
        onPending(false);
      });
    }
    gate.current = false;
  } catch (error) { gate.current = false; onError(error); }
}

// Explicitly imported by UI clients; never replaces the browser's global fetch.
// Background reads remain silent. A failed write must never announce success.
export async function actionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  let response: Response;
  try { response = await fetch(input, init); }
  catch (error) {
    if (mutation && !(error instanceof Error && error.name === "AbortError")) {
      const failure = new Error("Mất kết nối. Chưa xác nhận được kết quả; hãy tải lại số liệu trước khi thử lại.", { cause: error });
      notifyAction(failure.message, "error");
      throw failure;
    }
    throw error;
  }
  if (!mutation) return response;
  const payload = await response.clone().json().catch(() => null) as { message?: unknown; success?: boolean; ok?: boolean } | null;
  const message = typeof payload?.message === "string" ? payload.message : "";
  if (!response.ok || payload?.success === false || payload?.ok === false) {
    notifyAction(message || `Không thể hoàn tất thao tác (HTTP ${response.status}).`, "error");
  } else if (payload || response.status === 204) {
    notifyAction(message || (method === "DELETE" ? "Đã xóa dữ liệu thành công." : "Đã lưu dữ liệu thành công."));
  }
  return response;
}
