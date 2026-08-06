import { env } from "cloudflare:workers";

const MANAGER_HASH = "pbkdf2$100000$ZG9yZS1tYW5hZ2VyLTIwMjY=$d5VqMFL5PfeL24Iqy9+fDO394WhyMImlit02OntW4OM=";
const EMPLOYEE_HASH = "pbkdf2$100000$ZG9yZS1lbXBsb3llZS0yMDI2$OSC1V7zX59lTKx20h2VcBhh6m/M1e3zedhN05HKkju8=";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, address TEXT NOT NULL, revenue INTEGER NOT NULL DEFAULT 0, expense INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ACTIVE', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, position TEXT NOT NULL, phone TEXT NOT NULL, hourly_rate INTEGER NOT NULL DEFAULT 20000, status TEXT NOT NULL DEFAULT 'ACTIVE')`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, name TEXT NOT NULL, employee_id TEXT, store_id TEXT, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, shift_active INTEGER NOT NULL DEFAULT 0, current_shift TEXT, shift_started_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, store_id TEXT NOT NULL, employee_id TEXT NOT NULL, shift_code TEXT NOT NULL, customer_name TEXT, phone TEXT, age INTEGER, amount INTEGER NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, detail TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_store_shift ON orders(store_id, employee_id, shift_code, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_store ON employees(store_id, status)`,
];

const initialStores = [
  ["st-thot-not", "DORE THỐT NỐT", "Thốt Nốt, Cần Thơ", 567890000, 298450000],
  ["st-can-tho", "DORE CẦN THƠ", "Ninh Kiều, Cần Thơ", 678901000, 345670000],
  ["st-long-xuyen", "DORE LONG XUYÊN", "Long Xuyên, An Giang", 642098000, 357327000],
  ["st-vinh-long", "DORE VĨNH LONG", "TP. Vĩnh Long, Vĩnh Long", 456789000, 233120000],
  ["st-soc-trang", "DORE SÓC TRĂNG", "TP. Sóc Trăng, Sóc Trăng", 525430000, 272800000],
] as const;

export async function initDb() {
  const db = env.DB;
  if (!db) throw new Error("D1 binding DB is unavailable");
  await db.batch(schemaStatements.map((sql) => db.prepare(sql)));

  const count = await db.prepare("SELECT COUNT(*) AS count FROM stores").first<{ count: number }>();
  if (Number(count?.count ?? 0) === 0) {
    const now = new Date().toISOString();
    await db.batch(initialStores.map((store) => db.prepare("INSERT INTO stores (id, name, address, revenue, expense, status, created_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)").bind(...store, now)));
    await db.batch([
      db.prepare("INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')").bind("emp-001", "st-thot-not", "NV001", "Nguyễn Thị An", "Nhân viên bán hàng", "0765109784", 20000),
      db.prepare("INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')").bind("emp-002", "st-thot-not", "NV002", "Trần Văn Bình", "Nhân viên bán hàng", "0923456789", 20000),
      db.prepare("INSERT INTO employees (id, store_id, code, name, position, phone, hourly_rate, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')").bind("emp-003", "st-thot-not", "NV003", "Lê Thị Cúc", "Thu ngân", "0812345678", 22000),
      db.prepare("INSERT INTO users (id, username, password_hash, role, name, failed_attempts, shift_active) VALUES (?, ?, ?, 'MANAGER', ?, 0, 0)").bind("user-manager", "admin", MANAGER_HASH, "Quản trị viên"),
      db.prepare("INSERT INTO users (id, username, password_hash, role, name, employee_id, store_id, failed_attempts, shift_active) VALUES (?, ?, ?, 'EMPLOYEE', ?, ?, ?, 0, 0)").bind("user-employee", "nv001", EMPLOYEE_HASH, "Nguyễn Thị An", "emp-001", "st-thot-not"),
    ]);
  }
  await db.batch([
    db.prepare("UPDATE users SET password_hash = ? WHERE username = 'admin' AND password_hash LIKE 'pbkdf2$210000$%'").bind(MANAGER_HASH),
    db.prepare("UPDATE users SET password_hash = ? WHERE username = 'nv001' AND password_hash LIKE 'pbkdf2$210000$%'").bind(EMPLOYEE_HASH),
  ]);
  return db;
}

export async function writeAudit(userId: string | null, action: string, entityType: string, entityId: string | null, detail?: string) {
  const db = env.DB;
  if (!db) return;
  await db.prepare("INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, action, entityType, entityId, detail ?? null, new Date().toISOString()).run();
}
