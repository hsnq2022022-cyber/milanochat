import type { Page } from "@playwright/test";

/** Shared fake `flow-publication` server for the real activation toggle (page.route only, no network). */
export const MOCK_HOST = (process.env.VITE_SUPABASE_URL ?? "").startsWith("http://mock.");
const URL_ = process.env.VITE_SUPABASE_URL ?? "";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAKE_JWT = `${b64({ alg: "none" })}.${b64({ sub: "u1", exp: 4102444800, role: "authenticated" })}.sig`;

export type ActivationServer = {
  active: number | null;
  items?: number[];
  canActivate?: boolean;
  accountsFail?: boolean;
  /** HTTP status + error body returned for activate/deactivate. */
  mutationError?: { status: number; error: string };
  delayMs?: number;
  calls: Array<Record<string, any>>;
};

export async function mockActivation(page: Page, server: ActivationServer) {
  const ref = new URL(URL_).hostname.split(".")[0];
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    `sb-${ref}-auth-token`,
    JSON.stringify({
      access_token: FAKE_JWT, refresh_token: "r", token_type: "bearer", expires_in: 3600, expires_at: 4102444800,
      user: { id: "u1", aud: "authenticated", role: "authenticated", email: "t@example.test", app_metadata: {}, user_metadata: {}, created_at: "2024-01-01T00:00:00Z" },
    }),
  ]);
  await page.route(`${URL_}/**`, async (route) => {
    const req = route.request();
    const cors = { "access-control-allow-origin": "*" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    const body = req.postDataJSON?.() ?? {};
    const reply = (status: number, b: unknown) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(b) });
    if (!new URL(req.url()).pathname.endsWith("/flow-publication")) return reply(200, {});
    server.calls.push(body);
    switch (body.action) {
      case "accounts":
        if (server.accountsFail) return reply(503, { ok: false, error: "Service not configured" });
        return reply(200, { ok: true, accounts: [{ id: ACCOUNT, platform: "instagram", is_active: true, canActivate: server.canActivate ?? true }] });
      case "list":
        return reply(200, { ok: true, items: (server.items ?? [2, 1]).map((revision) => ({ revision, created_at: "2025-01-01" })), activation: server.active === null ? null : { revision: server.active, is_active: true } });
      case "activate": case "deactivate":
        if (server.delayMs) await new Promise((r) => setTimeout(r, server.delayMs));
        if (server.mutationError) return reply(server.mutationError.status, { ok: false, error: server.mutationError.error });
        server.active = body.action === "activate" ? body.revision : null;
        return reply(200, body.action === "activate" ? { ok: true, active: true, revision: body.revision } : { ok: true, active: false });
      default: return reply(200, { ok: false, error: "unexpected" });
    }
  });
}
