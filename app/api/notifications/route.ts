import { initDb } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";
import {
  MANAGER_STORE_SCOPE_MESSAGE,
  managerCanAccessStore,
  resolveManagerStoreScope,
} from "../_lib/manager-scope";

type NotificationRow = {
  id: string;
  storeId: string;
  storeName: string | null;
  type: string;
  entityType: string;
  entityId: string;
  title: string;
  message: string;
  dataJson: string;
  readAt: string | null;
  createdAt: string;
};

type NotificationCountRow = { count: number };

async function requireManager(request: Request) {
  const user = await getSessionUser(request);
  return user?.role === "MANAGER" ? user : null;
}

export async function GET(request: Request) {
  const user = await requireManager(request);
  if (!user) return json({ message: "Chỉ quản lý mới xem được thông báo." }, 403);
  const db = await initDb();
  const scope = resolveManagerStoreScope(user, new URL(request.url).searchParams.get("storeId"));
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeId = scope.storeId;
  if (storeId) {
    const store = await db.prepare("SELECT id FROM stores WHERE id = ? LIMIT 1").bind(storeId).first<{ id: string }>();
    if (!store) return json({ message: "Không tìm thấy cửa hàng." }, 404);
  }
  const storeClause = storeId ? " AND n.store_id = ?" : "";
  // Keep the list and badge count on the same database snapshot. Read rows are
  // deliberately excluded: `read_at` is the durable tombstone for the bell,
  // while the row remains available to audits and reset snapshots.
  const [items, count] = await db.batch([
    db.prepare(`SELECT n.id, n.store_id AS storeId, s.name AS storeName, n.type, n.entity_type AS entityType,
      n.entity_id AS entityId, n.title, n.message, n.data_json AS dataJson, n.read_at AS readAt, n.created_at AS createdAt
      FROM notifications n
      LEFT JOIN stores s ON s.id = n.store_id
      WHERE n.recipient_user_id = ? AND n.read_at IS NULL${storeClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT 50`).bind(user.id, ...(storeId ? [storeId] : [])),
    db.prepare(`SELECT COUNT(*) AS count FROM notifications n WHERE n.recipient_user_id = ? AND n.read_at IS NULL${storeClause}`)
      .bind(user.id, ...(storeId ? [storeId] : [])),
  ]);
  const countRow = count.results[0] as NotificationCountRow | undefined;
  return json({ notifications: items.results, unreadCount: Number(countRow?.count ?? 0) });
}

export async function PATCH(request: Request) {
  const user = await requireManager(request);
  if (!user) return json({ message: "Chỉ quản lý mới cập nhật được thông báo." }, 403);
  const body = await request.json().catch(() => ({})) as { id?: string; storeId?: string | null };
  const id = body.id?.trim();
  if (!id) return json({ message: "Thiếu mã thông báo." }, 400);
  const db = await initDb();
  const existing = await db.prepare("SELECT id, store_id AS storeId, read_at AS readAt FROM notifications WHERE id = ? AND recipient_user_id = ? LIMIT 1")
    .bind(id, user.id).first<{ id: string; storeId: string; readAt: string | null }>();
  if (!existing) return json({ message: "Không tìm thấy thông báo." }, 404);
  if (!managerCanAccessStore(user, existing.storeId)) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const scope = resolveManagerStoreScope(user, body.storeId);
  if (!scope.allowed) return json({ message: MANAGER_STORE_SCOPE_MESSAGE }, 403);
  const storeClause = scope.storeId ? " AND store_id = ?" : "";
  const now = new Date().toISOString();
  // COALESCE makes concurrent/repeated reads idempotent: only the first reader
  // chooses the timestamp. The count is calculated in the same transaction so
  // the client never needs to guess the badge value after removing the row.
  const [, readState, count] = await db.batch([
    db.prepare(`UPDATE notifications SET read_at = COALESCE(read_at, ?)
      WHERE id = ? AND recipient_user_id = ? AND store_id = ?`)
      .bind(now, id, user.id, existing.storeId),
    db.prepare("SELECT read_at AS readAt FROM notifications WHERE id = ? AND recipient_user_id = ? AND store_id = ? LIMIT 1")
      .bind(id, user.id, existing.storeId),
    db.prepare(`SELECT COUNT(*) AS count FROM notifications WHERE recipient_user_id = ? AND read_at IS NULL${storeClause}`)
      .bind(user.id, ...(scope.storeId ? [scope.storeId] : [])),
  ]);
  const persisted = readState.results[0] as Pick<NotificationRow, "readAt"> | undefined;
  const countRow = count.results[0] as NotificationCountRow | undefined;
  if (!persisted) {
    return json({ message: "Thông báo đã thay đổi. Vui lòng tải lại danh sách." }, 409);
  }
  return json({
    ok: true,
    id,
    readAt: persisted.readAt ?? existing.readAt ?? now,
    unreadCount: Number(countRow?.count ?? 0),
  });
}
