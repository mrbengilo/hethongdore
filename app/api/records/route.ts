import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

const allowedCategories = new Set([
  "TASKS", "MANAGER_PAYROLL", "TRANSFER", "DIVIDEND", "PROFILE",
  "CA_LAM_VIEC", "LICH_PHAN_CA", "NHAP_HANG", "CHAM_CONG",
  "LUONG_THUONG", "DONG_TIEN", "BAO_CAO", "CAI_DAT",
  "CHI_PHI_CO_DINH", "CHI_PHI_PHAT_SINH", "EMPLOYEE_BONUS",
  "EMPLOYEE_ALLOWANCE", "PAYROLL_PERIOD", "REPORT_SNAPSHOT",
]);

type RecordBody = {
  id?: string;
  category?: string;
  storeId?: string | null;
  title?: string;
  data?: Record<string, unknown>;
  status?: string;
  completedIndex?: number;
};

function parseRow(row: Record<string, unknown>) {
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(String(row.data_json ?? "{}")); } catch { data = {}; }
  return { ...row, data };
}

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const params = new URL(request.url).searchParams;
  const category = params.get("category") ?? "";
  if (!allowedCategories.has(category)) return json({ message: "Danh mục không hợp lệ" }, 400);
  if (user.role === "EMPLOYEE" && category !== "TASKS") return json({ message: "Không có quyền" }, 403);
  const db = await initDb();
  const requestedStore = params.get("storeId");
  const storeId = user.role === "EMPLOYEE" ? user.storeId : requestedStore;
  const result = storeId
    ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 300").bind(category, storeId).all()
    : category === "PROFILE"
      ? await db.prepare("SELECT * FROM business_records WHERE category = ? AND store_id IS NULL AND status != 'DELETED' ORDER BY created_at DESC LIMIT 300").bind(category).all()
      : await db.prepare("SELECT * FROM business_records WHERE category = ? AND status != 'DELETED' ORDER BY created_at DESC LIMIT 300").bind(category).all();
  return json({ records: result.results.map((row) => parseRow(row as Record<string, unknown>)) });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const body = await request.json().catch(() => ({})) as RecordBody;
  if (!body.category || !allowedCategories.has(body.category) || !body.title?.trim()) return json({ message: "Dữ liệu chưa đầy đủ" }, 400);
  if (user.role !== "MANAGER") return json({ message: "Chỉ quản lý được tạo dữ liệu" }, 403);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const db = await initDb();
  await db.prepare("INSERT INTO business_records (id, category, store_id, owner_id, title, data_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, body.category, body.storeId ?? null, user.id, body.title.trim(), JSON.stringify(body.data ?? {}), body.status ?? "ACTIVE", now, now).run();
  await writeAudit(user.id, "CREATE", body.category, id, body.title);
  return json({ id, createdAt: now, message: "Đã lưu dữ liệu" }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const body = await request.json().catch(() => ({})) as RecordBody;
  if (!body.id) return json({ message: "Thiếu mã dữ liệu" }, 400);
  const db = await initDb();
  const existing = await db.prepare("SELECT * FROM business_records WHERE id = ? AND status != 'DELETED'").bind(body.id).first<Record<string, unknown>>();
  if (!existing) return json({ message: "Không tìm thấy dữ liệu" }, 404);
  if (user.role === "EMPLOYEE") {
    if (existing.category !== "TASKS" || existing.store_id !== user.storeId || !Number.isInteger(body.completedIndex)) return json({ message: "Không có quyền" }, 403);
    const record = parseRow(existing);
    const items = Array.isArray(record.data.items) ? record.data.items as Array<Record<string, unknown>> : [];
    const index = Number(body.completedIndex);
    if (index < 0 || index >= items.length) return json({ message: "Công việc không hợp lệ" }, 400);
    const completedBy = Array.isArray(items[index].completedBy) ? items[index].completedBy as string[] : [];
    items[index] = { ...items[index], completedBy: completedBy.includes(user.id) ? completedBy.filter((id) => id !== user.id) : [...completedBy, user.id] };
    const data = { ...record.data, items };
    await db.prepare("UPDATE business_records SET data_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(data), new Date().toISOString(), body.id).run();
    await writeAudit(user.id, "TOGGLE_TASK", "TASKS", body.id, String(index));
    return json({ ok: true, data });
  }
  const title = body.title?.trim() || String(existing.title);
  const data = body.data ?? parseRow(existing).data;
  const updatedAt = new Date().toISOString();
  await db.prepare("UPDATE business_records SET title = ?, data_json = ?, status = ?, updated_at = ? WHERE id = ?")
    .bind(title, JSON.stringify(data), body.status ?? String(existing.status), updatedAt, body.id).run();
  await writeAudit(user.id, "UPDATE", String(existing.category), body.id, title);
  return json({ ok: true, updatedAt });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ message: "Thiếu mã dữ liệu" }, 400);
  const db = await initDb();
  await db.prepare("UPDATE business_records SET status = 'DELETED', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  await writeAudit(user.id, "DELETE", "BUSINESS_RECORD", id);
  return json({ ok: true });
}
