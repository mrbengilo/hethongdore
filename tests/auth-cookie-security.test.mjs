import assert from "node:assert/strict";
import test from "node:test";

const auth = await import("../app/api/_lib/auth.ts");
const logout = await import("../app/api/auth/logout/route.ts");

test("session cookies are Secure for HTTPS and forwarded HTTPS", () => {
  const directHttps = new Request("https://doregroup.io.vn/api/auth/login");
  const forwardedHttps = new Request("http://127.0.0.1:3000/api/auth/login", {
    headers: { "x-forwarded-proto": "https" },
  });
  const standardForwardedHttps = new Request("http://127.0.0.1:3000/api/auth/login", {
    headers: { forwarded: "for=127.0.0.1;proto=https;host=doregroup.io.vn" },
  });

  for (const request of [directHttps, forwardedHttps, standardForwardedHttps]) {
    const cookie = auth.sessionCookieHeader(request, "secret token", 3600);
    assert.match(cookie, /dore_session=secret%20token/u);
    assert.match(cookie, /; HttpOnly;/u);
    assert.match(cookie, /; SameSite=Lax;/u);
    assert.match(cookie, /; Secure$/u);
  }
});

test("production cookies remain Secure even when the application request is loopback HTTP", () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const cookie = auth.sessionCookieHeader(
      new Request("http://127.0.0.1:3000/api/auth/login"),
      "token",
      3600,
    );
    assert.match(cookie, /; Secure$/u);
  } finally {
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  }
});

test("logout deletion uses the same Secure policy behind the HTTPS proxy", async () => {
  const response = await logout.POST(new Request("http://127.0.0.1:3000/api/auth/logout", {
    method: "POST",
    headers: { "x-forwarded-proto": "https" },
  }));
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^dore_session=;/u);
  assert.match(cookie, /Max-Age=0/u);
  assert.match(cookie, /; Secure$/u);
});
