import { getSessionUser, json, sha256 } from "../../../_lib/auth";
import { processCccdDeletionOutbox } from "../../../_lib/cccd-deletion";

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function isMaintenanceAuthorized(request: Request) {
  const user = await getSessionUser(request);
  if (user?.role === "MANAGER" && Number(user.isSuperAdmin) === 1) return true;

  const configured = process.env.DORE_MAINTENANCE_TOKEN?.trim();
  const provided = bearerToken(request);
  if (!configured || !provided) return false;
  // Compare fixed-length digests rather than variable-length secret strings.
  return constantTimeEqual(await sha256(provided), await sha256(configured));
}

/**
 * Manual/scheduled maintenance entry point. The outbox processor also stages
 * expired unclaimed uploads before processing deletion retries, so this single
 * idempotent call covers both privacy queues.
 */
export async function POST(request: Request) {
  if (!await isMaintenanceAuthorized(request)) {
    return json({ message: "Không có quyền chạy tác vụ bảo trì." }, 403);
  }
  const result = await processCccdDeletionOutbox({ limit: 25 });
  return json({ ok: true, ...result });
}

export async function GET() {
  return json({ message: "Dùng POST để chạy tác vụ bảo trì CCCD." }, 405, { Allow: "POST" });
}
