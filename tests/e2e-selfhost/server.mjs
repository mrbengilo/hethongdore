import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// A new private SQLite fixture on every run. No production URL, DB or secret.
const directory = await mkdtemp(join(tmpdir(), "dore-swap-browser-"));
process.env.DORE_DB_PLATFORM = "sqlite";
process.env.DORE_DATABASE_PATH = join(directory, "fixture.sqlite");
process.env.DORE_UPLOAD_DIR = join(directory, "uploads");
process.env.NEXT_TELEMETRY_DISABLED = "1";
await mkdir(process.env.DORE_UPLOAD_DIR);
const { hashPassword } = await import("../../app/api/_lib/auth.ts");
process.env.DORE_MANAGER_PASSWORD_HASH = await hashPassword("Fixture-Swap-Only-2026");
const { initDb } = await import("../../db/runtime.ts");
const db = await initDb();
const stamp = "2099-01-01T00:00:00.000Z";
for (const id of ["browser-store", "browser-outside"]) {
  await db.prepare("INSERT INTO stores (id,name,address,status,created_at) VALUES (?,?,?,'ACTIVE',?)")
    .bind(id, id === "browser-store" ? "Cửa hàng kiểm thử đổi ca" : "Cửa hàng ngoài phạm vi", "Dữ liệu kiểm thử", "2020-01-01T00:00:00.000Z").run();
}
for (const [id, name] of [["a", "An"], ["b", "Bình"], ["c", "Chi Nguyễn Thị Tên Nhân Viên Rất Dài Để Kiểm Tra Xuống Dòng"]]) {
  await db.prepare("INSERT INTO employees (id,store_id,code,name,position,phone,status) VALUES (?,'browser-store',?,?,'Sales','','ACTIVE')")
    .bind(`browser-${id}`, id, name).run();
}
for (const [id, role, employee] of [["manager", "MANAGER", null], ["global", "MANAGER", null], ["htkd", "HTKD", null], ["employee", "EMPLOYEE", "browser-a"]]) {
  await db.prepare("INSERT INTO users (id,username,password_hash,role,name,store_id,employee_id) VALUES (?,?,?,?,?,?,?)")
    .bind(`browser-${id}`, `browser-${id}`, process.env.DORE_MANAGER_PASSWORD_HASH, role, id, id === "global" ? null : "browser-store", employee).run();
}
await db.prepare("INSERT INTO schedule_store_grants (user_id,store_id) VALUES ('browser-htkd','browser-store')").run();
// Independent day per scenario makes failures independent of test ordering.
for (let day = 1; day <= 12; day++) {
  const date = `2099-08-${String(day).padStart(2, "0")}`;
  for (const [slot, start, end, employeeIds] of [
    ["morning", "08:00", "12:00", ["browser-a"]],
    ["afternoon", "13:00", "17:00", ["browser-b"]],
    ["evening", "18:00", "21:00", ["browser-a", "browser-c"]],
  ]) {
    const id = `browser-${date}-${slot}`;
    const name = { morning: "Ca sáng", afternoon: "Ca chiều", evening: "Ca tối" }[slot];
    const data = { date, shiftId: `${id}-def`, shiftDefinitionVersion: 1, shiftName: name, start, end,
      startAt: new Date(`${date}T${start}:00+07:00`).toISOString(), endAt: new Date(`${date}T${end}:00+07:00`).toISOString(),
      employeeIds, employeeNames: employeeIds.map((employee) => ({ "browser-a": "An", "browser-b": "Bình", "browser-c": "Chi" })[employee]), note: "Giữ ghi chú" };
    await db.prepare(`INSERT INTO daily_shift_definitions (id,store_id,work_date,name,name_key,start_time,end_time,status,version,created_by,created_at,updated_at)
      VALUES (?,'browser-store',?,?,?,?,?,'ACTIVE',1,'browser-manager',?,?)`)
      .bind(`${id}-def`, date, name, slot, start, end, stamp, stamp).run();
    await db.prepare(`INSERT INTO business_records (id,category,store_id,owner_id,title,data_json,status,created_at,updated_at)
      VALUES (?,'LICH_PHAN_CA','browser-store','browser-manager',?,?,'ACTIVE',?,?)`)
      .bind(id, name, JSON.stringify(data), stamp, stamp).run();
  }
}
db.close();
const server = spawn(process.execPath, [".next/standalone/server.js"], {
  stdio: "inherit", env: { ...process.env, PORT: "3184", HOSTNAME: "127.0.0.1", NODE_ENV: "production" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
