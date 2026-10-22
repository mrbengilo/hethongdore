import { getSessionUser, json } from "../../_lib/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request, { allowSchedulingRole: true });
  if (!user) return json({ message: "Chưa đăng nhập" }, 401);
  return json({ user });
}

