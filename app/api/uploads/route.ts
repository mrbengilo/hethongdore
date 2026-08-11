import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import { processCccdDeletionOutbox } from "../_lib/cccd-deletion";
import { CCCD_UPLOAD_KEY_PATTERN, getCccdStorage } from "../_lib/cccd-storage";
import { registerPendingCccdUpload } from "../_lib/cccd-upload-registry";
import { managerHasGlobalStoreAccess } from "../_lib/manager-scope";

// getCccdStorage selects the self-hosted directory or Cloudflare UPLOADS R2 binding.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

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
  const storage = await getCccdStorage();
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
    contentType: file.type,
    originalName,
    uploadedBy: user.id,
  });
  const createdAt = new Date().toISOString();
  const db = await initDb();
  try {
    await registerPendingCccdUpload({
      db,
      storage,
      key,
      actorUserId: user.id,
      actorStoreId: user.homeStoreId,
      actorGlobalAccess: managerHasGlobalStoreAccess(user),
      originalName,
      contentType: file.type,
      createdAt,
    });
  } catch {
    return json({ message: "Không thể đăng ký ảnh CCCD. Ảnh chưa được lưu; vui lòng thử lại." }, 500);
  }
  // A failed physical deletion never blocks a profile update. Retrying a few
  // durable outbox entries on later uploads gradually cleans both local and R2
  // storage while the read guard keeps detached objects inaccessible.
  await processCccdDeletionOutbox({ limit: 3 }).catch(() => undefined);
  return json({ key, name: originalName, url: `/api/uploads?key=${encodeURIComponent(key)}` }, 201);
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền xem ảnh CCCD." }, 403);
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (!CCCD_UPLOAD_KEY_PATTERN.test(key)) return json({ message: "Mã ảnh không hợp lệ." }, 400);

  // Authorization is tied to the live employee record, never merely to
  // possession of a random object key. A normal manager is restricted to the
  // assigned store; a global manager and super-admin can inspect every store.
  // This check deliberately runs before storage.get so purged, replaced and
  // orphaned objects are indistinguishable even if their bytes still exist.
  const db = await initDb();
  const globallyScoped = managerHasGlobalStoreAccess(user);
  const attached = globallyScoped
    ? await db.prepare(`SELECT id FROM employees
        WHERE cccd_image_key = ? AND status != 'ARCHIVED' AND deleted_at IS NULL
        LIMIT 1`).bind(key).first<{ id: string }>()
    : await db.prepare(`SELECT id FROM employees
        WHERE cccd_image_key = ? AND store_id = ?
          AND status != 'ARCHIVED' AND deleted_at IS NULL
        LIMIT 1`).bind(key, user.homeStoreId).first<{ id: string }>();
  if (!attached) return json({ message: "Không tìm thấy ảnh." }, 404);

  const storage = await getCccdStorage();
  if (!storage) return json({ message: "Kho ảnh chưa được cấu hình." }, 503);
  const object = await storage.get(key);
  if (!object) return json({ message: "Không tìm thấy ảnh." }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": object.contentType,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      Vary: "Cookie",
    },
  });
}
