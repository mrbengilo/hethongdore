import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const result = user.role === "MANAGER"
    ? await db.prepare("SELECT *, revenue - expense AS profit FROM stores WHERE status IN ('ACTIVE', 'INACTIVE') ORDER BY created_at").all()
    : await db.prepare("SELECT *, revenue - expense AS profit FROM stores WHERE id = ?").bind(user.storeId).all();
  return json({ stores: result.results });
}

export async function POST(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { name?: string; address?: string };
  const name = body.name?.trim().toUpperCase();
  const address = body.address?.trim();
  if (!name || !address) return json({ message: "Tên và địa chỉ cửa hàng là bắt buộc." }, 400);
  const db = await initDb();
  const id = `st-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await db.prepare("INSERT INTO stores (id, name, address, revenue, expense, status, created_at) VALUES (?, ?, ?, 0, 0, 'ACTIVE', ?)").bind(id, name, address, new Date().toISOString()).run();
  } catch {
    return json({ message: "Tên cửa hàng đã tồn tại." }, 409);
  }
  await writeAudit(user.id, "CREATE", "STORE", id, name);
  return json({ id, message: "Đã tạo cửa hàng và toàn bộ danh mục mặc định." }, 201);
}

export async function PATCH(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const body = await request.json().catch(() => ({})) as { id?: string; name?: string; address?: string; status?: string };
  if (!body.id || !body.name?.trim() || !body.address?.trim() || !["ACTIVE", "INACTIVE"].includes(body.status ?? "ACTIVE")) return json({ message: "Dữ liệu không hợp lệ." }, 400);
  const db = await initDb();
  const existing = await db.prepare("SELECT name, status FROM stores WHERE id = ? AND status IN ('ACTIVE', 'INACTIVE') LIMIT 1")
    .bind(body.id).first<{ name: string; status: string }>();
  if (!existing) return json({ message: "Không tìm thấy cửa hàng." }, 404);
  const nextStatus = body.status ?? existing.status;
  if (existing.status === "ACTIVE" && nextStatus === "INACTIVE") {
    const activeShifts = await db.prepare("SELECT COUNT(*) AS count FROM shift_sessions WHERE store_id = ? AND status = 'ACTIVE'")
      .bind(body.id).first<{ count: number }>();
    if (Number(activeShifts?.count ?? 0) > 0) {
      return json({ message: "Cửa hàng còn ca làm đang hoạt động. Hãy kết thúc các ca trước khi ngưng hoạt động." }, 409);
    }
  }
  await db.prepare("UPDATE stores SET name = ?, address = ?, status = ? WHERE id = ?")
    .bind(body.name.trim().toUpperCase(), body.address.trim(), nextStatus, body.id).run();
  await writeAudit(user.id, existing.status === nextStatus ? "UPDATE" : "STORE_STATUS_CHANGE", "STORE", body.id, JSON.stringify({ from: existing.status, to: nextStatus }));
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  return json({ message: "Không hỗ trợ xóa cửa hàng. Hãy chuyển cửa hàng sang trạng thái ngưng hoạt động." }, 405, { Allow: "GET, POST, PATCH" });
}
