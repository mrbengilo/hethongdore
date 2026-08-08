import { env } from "cloudflare:workers";
import { writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

type StoredObject = {
  body: ReadableStream<Uint8Array>;
  httpMetadata?: { contentType?: string };
};

type UploadBucket = {
  put: (key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => Promise<unknown>;
  get: (key: string) => Promise<StoredObject | null>;
};

function bucket() {
  return (env as unknown as { UPLOADS?: UploadBucket }).UPLOADS;
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function validImageContent(buffer: ArrayBuffer, contentType: string) {
  const bytes = new Uint8Array(buffer);
  if (contentType === "image/jpeg") return bytes.length >= 3 && hasBytes(bytes, 0, [0xff, 0xd8, 0xff]);
  if (contentType === "image/png") return bytes.length >= 8 && hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (contentType === "image/webp") return bytes.length >= 12
    && hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46])
    && hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50]);
  return false;
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền tải ảnh CCCD." }, 403);
  const storage = bucket();
  if (!storage) return json({ message: "Kho ảnh chưa được cấu hình." }, 503);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return json({ message: "Vui lòng chọn ảnh CCCD." }, 400);
  const extension = IMAGE_TYPES.get(file.type);
  if (!extension) return json({ message: "Ảnh CCCD chỉ hỗ trợ JPG, PNG hoặc WebP." }, 400);
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) return json({ message: "Ảnh CCCD phải nhỏ hơn hoặc bằng 5 MB." }, 400);
  const imageBuffer = await file.arrayBuffer();
  if (!validImageContent(imageBuffer, file.type)) return json({ message: "Nội dung tệp không đúng định dạng ảnh đã chọn." }, 400);
  const key = `cccd/${crypto.randomUUID()}.${extension}`;
  const originalName = [...file.name]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("").trim().slice(0, 200) || `cccd.${extension}`;
  await storage.put(key, imageBuffer, {
    httpMetadata: { contentType: file.type },
    customMetadata: { originalName, uploadedBy: user.id },
  });
  await writeAudit(user.id, "UPLOAD", "EMPLOYEE_CCCD", key, originalName);
  return json({ key, name: originalName, url: `/api/uploads?key=${encodeURIComponent(key)}` }, 201);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền xem ảnh CCCD." }, 403);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!/^cccd\/[a-f0-9-]+\.(jpg|png|webp)$/.test(key)) return json({ message: "Mã ảnh không hợp lệ." }, 400);
  const storage = bucket();
  if (!storage) return json({ message: "Kho ảnh chưa được cấu hình." }, 503);
  const object = await storage.get(key);
  if (!object) return json({ message: "Không tìm thấy ảnh." }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
