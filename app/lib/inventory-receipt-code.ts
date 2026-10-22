const inventoryRequestPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function normalizeInventoryReceiptClientRequestId(value: unknown) {
  const requestId = String(value ?? "").trim();
  return inventoryRequestPattern.test(requestId) ? requestId : null;
}

export function inventoryReceiptServerDate(value: Date | string = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid receipt timestamp");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function inventoryReceiptDateToken(receiptDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(receiptDate);
  if (!match) throw new RangeError("Invalid receipt date");
  return `${match[3]}${match[2]}${match[1]}`;
}

export function inventoryReceiptCode(receiptDate: string, sequence: number) {
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new RangeError("Invalid receipt sequence");
  return `PN-${inventoryReceiptDateToken(receiptDate)}-${String(sequence).padStart(5, "0")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().filter((key) => source[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function inventoryReceiptPayloadHash(value: unknown) {
  return sha256(canonicalJson(value));
}

export async function inventoryReceiptRecordId(storeId: string, actorId: string, clientRequestId: string) {
  return `inventory-receipt-${await sha256(`${storeId}\u0000${actorId}\u0000${clientRequestId}`)}`;
}
