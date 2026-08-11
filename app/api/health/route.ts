import { mkdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { initDb } from "../../../db/runtime";

export const dynamic = "force-dynamic";

function isSelfHosted() {
  return Boolean(
    process.env.DORE_DATABASE_PATH?.trim()
      || process.env.DORE_DB_PLATFORM?.trim().toLowerCase() === "sqlite",
  );
}

async function checkDatabase() {
  // Readiness must exercise the same initialization path as real requests.
  // This validates the injected manager hash, creates/updates the schema, and
  // bootstraps a fresh self-hosted database before a release can go live.
  const database = await initDb();
  const probe = await database.prepare(`SELECT
    (SELECT COUNT(*) FROM stores) AS store_count,
    (SELECT COUNT(*) FROM users WHERE role = 'MANAGER') AS manager_count`)
    .first<{ store_count: number; manager_count: number }>();
  if (Number(probe?.store_count ?? 0) < 1 || Number(probe?.manager_count ?? 0) < 1) {
    throw new Error("Database readiness requires at least one store and one manager account");
  }
}

async function checkLocalUploadDirectory() {
  if (!isSelfHosted()) return;
  const uploadRoot = process.env.DORE_UPLOAD_DIR?.trim();
  if (!uploadRoot || !isAbsolute(uploadRoot)) {
    throw new Error("Self-hosted upload storage is not configured with an absolute path");
  }

  await mkdir(uploadRoot, { recursive: true, mode: 0o700 });
  const probe = join(uploadRoot, `.health-${process.pid}-${crypto.randomUUID()}`);
  try {
    await writeFile(probe, "ok", { flag: "wx", mode: 0o600 });
  } finally {
    await unlink(probe).catch(() => undefined);
  }
}

export async function GET() {
  try {
    await Promise.all([checkDatabase(), checkLocalUploadDirectory()]);
    return Response.json(
      {
        status: "ok",
        service: "dore-store-management",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("Health check failed", error);
    return Response.json(
      {
        status: "unhealthy",
        service: "dore-store-management",
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
