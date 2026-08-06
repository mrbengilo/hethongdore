import { initDb, writeAudit } from "../../../db/runtime";
import { getSessionUser, json } from "../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  const db = await initDb();
  const result = user.role === "MANAGER"
    ? await db.prepare("SELECT *, revenue - expense AS profit FROM stores WHERE status != 'ARCHIVED' ORDER BY created_at").all()
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
  const body = await request.json().catch(() => ({})) as { id?: string; name?: string; address?: string };
  if (!body.id || !body.name?.trim() || !body.address?.trim()) return json({ message: "Dữ liệu không hợp lệ." }, 400);
  const db = await initDb();
  await db.prepare("UPDATE stores SET name = ?, address = ? WHERE id = ?").bind(body.name.trim().toUpperCase(), body.address.trim(), body.id).run();
  await writeAudit(user.id, "UPDATE", "STORE", body.id, body.name);
  return json({ ok: true });
}

export async function DELETE(request: Request) {
  const user = await getSessionUser(request);
  if (!user || user.role !== "MANAGER") return json({ message: "Không có quyền" }, 403);
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return json({ message: "Thiếu mã cửa hàng." }, 400);
  const db = await initDb();
  await db.prepare("UPDATE stores SET status = 'ARCHIVED' WHERE id = ?").bind(id).run();
  await writeAudit(user.id, "ARCHIVE", "STORE", id);
  return json({ ok: true });
}

