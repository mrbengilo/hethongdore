/** A failed or truncated mutation response must never look like a successful payment. */
export async function readFinancialResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Máy chủ chưa trả kết quả hợp lệ (HTTP ${response.status}). Hãy kiểm tra trạng thái kỳ trước khi thử lại.`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Phản hồi tài chính không hợp lệ. Vui lòng tải lại để kiểm tra trạng thái kỳ.");
  }
  if (!response.ok) {
    const { message, requestId } = payload as { message?: unknown; requestId?: unknown };
    const detail = typeof message === "string" ? message : "Không thể xử lý kỳ. Vui lòng tải lại để kiểm tra trạng thái.";
    throw new Error(typeof requestId === "string" ? `${detail} Mã lỗi: ${requestId}` : detail);
  }
  return payload as T;
}
