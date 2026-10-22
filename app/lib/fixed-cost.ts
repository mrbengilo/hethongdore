const fixedCostRequestPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function normalizeFixedCostClientRequestId(value: unknown) {
  const requestId = String(value ?? "").trim();
  return fixedCostRequestPattern.test(requestId) ? requestId : null;
}

export async function fixedCostRecordId(storeId: string, clientRequestId: string) {
  const payload = new TextEncoder().encode(`${storeId}\u0000${clientRequestId}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `fixed-cost-${hex}`;
}
