/**
 * مسارات ربط Meta عبر OAuth — Facebook Pages + Instagram Professional
 *
 * التدفق المعتمد:
 *   Instagram API with Facebook Login
 *
 * يدعم الملف أيضًا Instagram Login المباشر عند تفعيله صراحةً
 * باستخدام USE_INSTAGRAM_DIRECT_LOGIN=true وضبط أسرار Instagram.
 *
 * ملاحظات:
 * - تُحفظ بيانات الحساب في channel_accounts.
 * - تُحدّث حالة القناة في channels.
 * - لا تُحذف الرسائل أو المحادثات عند ربط الحساب.
 */

import express, { Router } from "express";
import crypto from "node:crypto";
import { db, authClient } from "../db.js";
import {
  config,
  buildMetaCallbackUrl,
  buildInstagramCallbackUrl,
} from "../config.js";
import { encryptField } from "../crypto.js";

export const metaAuthRouter = Router();

const GRAPH_API = "https://graph.facebook.com/v21.0";

const SCOPES: Record<string, string[]> = {
  facebook: [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
    "business_management",
  ],
  instagram: [
    "instagram_basic",
    "instagram_manage_messages",
    "pages_read_engagement",
    "pages_show_list",
    "business_management",
    "pages_manage_metadata",
    "pages_messaging",
  ],
};

/* ═══════════ Instagram Login المباشر ═══════════ */

const IG_AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const IG_TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH_HOST = "https://graph.instagram.com";
const IG_GRAPH_V = `${IG_GRAPH_HOST}/v21.0`;

const IG_LOGIN_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
];

function instagramLoginConfigured(): boolean {
  return Boolean(
    process.env.INSTAGRAM_APP_ID &&
      process.env.INSTAGRAM_APP_SECRET
  );
}

async function markChannelConnected(
  tenantId: string,
  platform: string,
  accountName: string,
  accountId: string
) {
  const { data: existing, error: selectError } = await db
    .from("channels")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("platform", platform)
    .maybeSingle();

  if (selectError) {
    console.warn(
      "[Meta Auth] channels lookup failed:",
      selectError.message
    );
  }

  const row = {
    is_connected: true,
    connected_at: new Date().toISOString(),
    account_name: accountName || null,
    platform_account_id: accountId || null,
  };

  const { error } = existing?.id
    ? await db
        .from("channels")
        .update(row)
        .eq("id", existing.id)
    : await db.from("channels").insert({
        tenant_id: tenantId,
        platform,
        ...row,
      });

  if (error) {
    console.warn(
      "[Meta Auth] channels write failed:",
      error.message
    );
  }
}

/* ═══════════ Instagram Login callback ═══════════ */

async function handleInstagramLoginCallback(a: {
  res: any;
  code: string;
  tenantId: string;
  frontBase: string;
  fail: (code: string) => any;
}) {
  const { res, tenantId, frontBase, fail } = a;
  const code = a.code.replace(/#_$/, "");

  const igAppId = process.env.INSTAGRAM_APP_ID;
  const igSecret = process.env.INSTAGRAM_APP_SECRET;

  if (!igAppId || !igSecret) {
    console.error("[Meta Auth] Instagram credentials are missing");
    return fail("oauth_not_configured");
  }

  let redirectUri: string;

  try {
    redirectUri = buildInstagramCallbackUrl();
  } catch (e: any) {
    console.error(
      "[Meta Auth] Instagram redirect URI build failed:",
      e?.message
    );
    return fail("config_redirect_uri");
  }

  console.log(
    "[Meta Auth] Instagram Login callback → redirect_uri:",
    redirectUri
  );

  try {
    // 1) Exchange authorization code for a short-lived token.
    const tRes = await fetch(IG_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: igAppId,
        client_secret: igSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      }),
    });

    const tJson: any = await tRes.json().catch(() => ({}));
    const first = Array.isArray(tJson?.data)
      ? tJson.data[0]
      : tJson;

    const shortToken: string | undefined = first?.access_token;

    if (!tRes.ok || !shortToken) {
      console.error(
        "[Meta Auth] Instagram token exchange failed:",
        tJson?.error_message ??
          tJson?.error?.message ??
          "unknown"
      );
      return fail("oauth_token_exchange");
    }

    console.log("[Meta Auth] Instagram token exchange OK");

    // 2) Exchange the token for a long-lived token where supported.
    let token = shortToken;
    let expiresIn = 3600;

    const longTokenUrl =
      `${IG_GRAPH_HOST}/access_token` +
      `?grant_type=ig_exchange_token` +
      `&client_secret=${encodeURIComponent(igSecret)}` +
      `&access_token=${encodeURIComponent(shortToken)}`;

    const lRes = await fetch(longTokenUrl);
    const lJson: any = await lRes.json().catch(() => ({}));

    if (lRes.ok && lJson?.access_token) {
      token = lJson.access_token;
      expiresIn = Number(lJson.expires_in ?? 5184000);
    } else {
      console.warn(
        "[Meta Auth] Instagram long-lived token exchange failed:",
        lJson?.error?.message ?? "unknown"
      );
    }

    // 3) Retrieve Instagram profile details.
    const profileUrl =
      `${IG_GRAPH_V}/me` +
      `?fields=user_id,username,name,profile_picture_url,account_type` +
      `&access_token=${encodeURIComponent(token)}`;

    const pRes = await fetch(profileUrl);
    const prof: any = await pRes.json().catch(() => ({}));

    const igId = String(
      prof?.user_id ?? prof?.id ?? first?.user_id ?? ""
    );

    if (!pRes.ok || !igId) {
      console.error(
        "[Meta Auth] Instagram /me failed:",
        prof?.error?.message ?? "no id returned"
      );
      return fail("no_eligible_instagram");
    }

    console.log(
      `[Meta Auth] Instagram profile: ${
        prof?.username ?? igId
      } type=${prof?.account_type ?? "unknown"}`
    );

    if (
      prof?.account_type &&
      !["BUSINESS", "MEDIA_CREATOR"].includes(
        prof.account_type
      )
    ) {
      return fail(
        "no_eligible_instagram — الحساب يجب أن يكون Business أو Creator"
      );
    }

    const { data: taken, error: takenError } = await db
      .from("channel_accounts")
      .select("tenant_id")
      .eq("channel", "instagram")
      .eq("external_id", igId)
      .neq("tenant_id", tenantId)
      .eq("status", "active")
      .maybeSingle();

    if (takenError) {
      console.warn(
        "[Meta Auth] Instagram ownership check failed:",
        takenError.message
      );
    }

    if (taken) {
      console.warn(
        `[Meta Auth] Instagram account ${igId} already belongs to another tenant`
      );
      return fail("account_already_linked");
    }

    // 4) Save the account and its current profile image URL.
    const username = prof?.username
      ? `@${prof.username}`
      : prof?.name ?? null;

    const avatarUrl =
      typeof prof?.profile_picture_url === "string" &&
      prof.profile_picture_url.length > 0
        ? prof.profile_picture_url
        : null;

    if (!avatarUrl) {
      console.warn(
        "[Meta Auth] Instagram profile did not return profile_picture_url"
      );
    }

    const { error: upErr } = await db
      .from("channel_accounts")
      .upsert(
        {
          tenant_id: tenantId,
          channel: "instagram",
          external_id: igId,
          display_name: username,
          avatar_url: avatarUrl,
          status: "active",
          access_token_encrypted: encryptField(token),
          token_expires_at: new Date(
            Date.now() + expiresIn * 1000
          ).toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "tenant_id,channel,external_id",
        }
      );

    if (upErr) {
      console.error(
        "[Meta Auth] channel_accounts upsert FAILED:",
        upErr.message
      );
      return fail("db_save_failed");
    }

    // 5) Subscribe to Instagram webhooks.
    try {
      const subscribeUrl =
        `${IG_GRAPH_V}/me/subscribed_apps` +
        `?subscribed_fields=messages,messaging_postbacks,messaging_seen` +
        `&access_token=${encodeURIComponent(token)}`;

      const sRes = await fetch(subscribeUrl, {
        method: "POST",
      });

      const sJson: any = await sRes.json().catch(() => ({}));

      if (sRes.ok && sJson?.success) {
        console.log("[Meta Auth] Instagram webhooks subscribed");
      } else {
        console.error(
          "[Meta Auth] Instagram subscribed_apps failed:",
          sJson?.error?.message ?? JSON.stringify(sJson)
        );
      }
    } catch (e: any) {
      console.error(
        "[Meta Auth] Instagram webhook subscription error:",
        e?.message
      );
    }

    await markChannelConnected(
      tenantId,
      "instagram",
      username ?? "",
      igId
    );

    console.log(
      "[Meta Auth] Instagram Login completed — account:",
      igId,
      "avatar:",
      avatarUrl ? "received" : "missing"
    );

    return res.redirect(
      `${frontBase}?channel_connected=instagram&accounts=1&name=${encodeURIComponent(
        username ?? ""
      )}`
    );
  } catch (e: any) {
    console.error(
      "[Meta Auth] Instagram callback error:",
      e?.message ?? e
    );

    return fail(
      e?.message
        ? String(e.message).slice(0, 120)
        : "unknown"
    );
  }
}

/* ═══════════ Frontend URL ═══════════ */

function frontendDashboardUrl(): string {
  const origin = (
    process.env.FRONTEND_ORIGIN ||
    config.frontendOrigin ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");

  return `${origin}/milanochat/#/dashboard`;
}

/* ═══════════ Tenant ownership ═══════════ */

async function ownedTenant(
  userId: string,
  tenantId?: string
) {
  if (!tenantId) return null;

  const { data, error } = await db
    .from("tenants")
    .select("id")
    .eq("id", tenantId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.warn(
      "[Meta Auth] Tenant ownership lookup failed:",
      error.message
    );
  }

  return data;
}

/* ═══════════ OAuth state ═══════════ */

type OAuthStatePayload = {
  u: string;
  t: string;
  p: string;
  i: string;
  exp: number;
};

const STATE_TTL_SEC = 15 * 60;

function stateSecret(): string {
  const secret = process.env.META_APP_SECRET || "";

  if (!secret) {
    throw new Error(
      "META_APP_SECRET مفقود — لا يمكن توقيع/التحقق من OAuth state"
    );
  }

  return secret;
}

function hmacSign(body: string): string {
  return crypto
    .createHmac("sha256", stateSecret())
    .update(body)
    .digest("base64url");
}

async function createOAuthState(rec: {
  platform: string;
  tenantId: string;
  userId: string;
}): Promise<{ state: string; nonce: string } | null> {
  const nonce = crypto.randomBytes(12).toString("hex");

  const payload: OAuthStatePayload = {
    u: rec.userId,
    t: rec.tenantId,
    p: rec.platform,
    i: nonce,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
  };

  const body = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const state = `${body}.${hmacSign(body)}`;

  const expiresAt = new Date(
    payload.exp * 1000
  ).toISOString();

  const { error } = await db
    .from("meta_oauth_states")
    .insert({
      id: nonce,
      user_id: rec.userId,
      tenant_id: rec.tenantId,
      platform: rec.platform,
      expires_at: expiresAt,
      consumed: false,
    });

  if (error) {
    console.warn(
      "[Meta Auth] meta_oauth_states insert failed:",
      error.message
    );
    return null;
  }

  return { state, nonce };
}

async function consumeOAuthState(
  state: string
): Promise<
  | {
      ok: true;
      session: {
        platform: string;
        tenantId: string;
        userId: string;
      };
    }
  | { ok: false; reason: string }
> {
  let decoded: Partial<OAuthStatePayload> | null = null;

  try {
    const dot = state.lastIndexOf(".");

    if (dot <= 0) {
      return { ok: false, reason: "state_format" };
    }

    const body = state.slice(0, dot);
    const sig = state.slice(dot + 1);
    const expected = hmacSign(body);

    if (
      sig.length !== expected.length ||
      !crypto.timingSafeEqual(
        Buffer.from(sig),
        Buffer.from(expected)
      )
    ) {
      return { ok: false, reason: "state_signature" };
    }

    decoded = JSON.parse(
      Buffer.from(body, "base64url").toString()
    ) as Partial<OAuthStatePayload>;

    if (
      !decoded?.u ||
      !decoded?.t ||
      !decoded?.p ||
      !decoded?.i ||
      !decoded?.exp
    ) {
      return { ok: false, reason: "state_payload" };
    }

    if (
      decoded.p !== "facebook" &&
      decoded.p !== "instagram"
    ) {
      return { ok: false, reason: "state_platform" };
    }
  } catch {
    return { ok: false, reason: "state_parse" };
  }

  if (
    Math.floor(Date.now() / 1000) >
    decoded!.exp!
  ) {
    return { ok: false, reason: "state_expired" };
  }

  const { data: row, error: selErr } = await db
    .from("meta_oauth_states")
    .select("id, consumed")
    .eq("id", decoded!.i!)
    .maybeSingle();

  if (selErr) {
    console.warn(
      "[Meta Auth] meta_oauth_states select failed:",
      selErr.message
    );
    return { ok: false, reason: "state_lookup_failed" };
  }

  if (!row) {
    console.warn(
      "[Meta Auth] meta_oauth_states: no record for nonce"
    );
    return { ok: false, reason: "state_not_found" };
  }

  if (row.consumed) {
    return { ok: false, reason: "state_reused" };
  }

  const { data: updatedRows, error: updErr } = await db
    .from("meta_oauth_states")
    .update({ consumed: true })
    .eq("id", decoded!.i!)
    .eq("consumed", false)
    .select("id");

  if (updErr) {
    console.warn(
      "[Meta Auth] mark state consumed failed:",
      updErr.message
    );
    return { ok: false, reason: "state_consume_failed" };
  }

  if (!updatedRows?.length) {
    return { ok: false, reason: "state_reused" };
  }

  return {
    ok: true,
    session: {
      userId: decoded!.u!,
      tenantId: decoded!.t!,
      platform: decoded!.p!,
    },
  };
}

/* ═══════════ User authentication ═══════════ */

async function requireUser(
  req: any,
  res: any,
  next: any
) {
  const header = String(
    req.headers.authorization ?? ""
  );

  const token = header.startsWith("Bearer ")
    ? header.slice(7)
    : req.method === "GET"
      ? String(req.query?.t ?? "") || null
      : null;

  if (!token) {
    return res.status(401).json({
      error: "غير مصرح",
    });
  }

  try {
    const { data, error } =
      await authClient.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({
        error: "جلسة غير صالحة",
      });
    }

    req.userId = data.user.id;
    return next();
  } catch {
    return res.status(401).json({
      error: "تحقق فشل",
    });
  }
}

const protectedRoutes = express.Router();
protectedRoutes.use(requireUser);

/* ═══════════ Instagram Login callback ═══════════ */

metaAuthRouter.get(
  "/instagram/callback",
  async (req: any, res) => {
    const frontBase = frontendDashboardUrl();

    const fail = (code: string) => {
      console.warn(
        "[Meta Auth] Instagram callback FAILED →",
        code
      );

      return res.redirect(
        `${frontBase}?channel_error=${encodeURIComponent(code)}`
      );
    };

    console.log(
      "[Meta Auth] Instagram callback ENTERED — params:",
      Object.keys(req.query ?? {})
    );

    const {
      code,
      state,
      error: metaError,
    } = req.query as Record<string, string>;

    if (metaError) {
      return fail(
        metaError === "access_denied"
          ? "user_cancelled"
          : metaError
      );
    }

    if (!code || !state) {
      return fail("missing_params");
    }

    const stateResult = await consumeOAuthState(
      String(state)
    );

    if (!stateResult.ok) {
      return fail(
        `oauth_state:${stateResult.reason}`
      );
    }

    const { platform, tenantId } =
      stateResult.session;

    if (platform !== "instagram") {
      return fail("oauth_state_platform_mismatch");
    }

    return handleInstagramLoginCallback({
      res,
      code: String(code),
      tenantId,
      frontBase,
      fail,
    });
  }
);

/* ═══════════ Facebook OAuth callback ═══════════ */

metaAuthRouter.get(
  "/facebook/callback",
  async (req: any, res) => {
    const frontBase = frontendDashboardUrl();

    const fail = (code: string) => {
      console.warn(
        "[Meta Auth] callback FAILED →",
        code
      );

      return res.redirect(
        `${frontBase}?channel_error=${encodeURIComponent(code)}`
      );
    };

    console.log(
      "[Meta Auth] callback ENTERED — params:",
      Object.keys(req.query ?? {})
    );

    const {
      code,
      state,
      error: metaError,
    } = req.query as Record<string, string>;

    if (metaError) {
      return fail(
        metaError === "access_denied"
          ? "user_cancelled"
          : metaError
      );
    }

    if (!code || !state) {
      return fail("missing_params");
    }

    const stateResult = await consumeOAuthState(
      String(state)
    );

    if (!stateResult.ok) {
      return fail(
        `oauth_state:${stateResult.reason}`
      );
    }

    const { platform, tenantId } =
      stateResult.session;

    if (
      platform === "instagram" &&
      process.env.USE_INSTAGRAM_DIRECT_LOGIN === "true" &&
      instagramLoginConfigured()
    ) {
      return handleInstagramLoginCallback({
        res,
        code: String(code),
        tenantId,
        frontBase,
        fail,
      });
    }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return fail("oauth_not_configured");
    }

    let redirectUri: string;

    try {
      redirectUri = buildMetaCallbackUrl();
    } catch (e: any) {
      console.error(
        "[Meta Auth] redirect URI build failed:",
        e?.message
      );
      return fail("config_redirect_uri");
    }

    console.log(
      "[Meta Auth] OAuth callback → redirect_uri:",
      redirectUri,
      "platform:",
      platform
    );

    try {
      // 1) Exchange authorization code for access token.
      const tokenUrl =
        `${GRAPH_API}/oauth/access_token` +
        `?client_id=${encodeURIComponent(appId)}` +
        `&client_secret=${encodeURIComponent(appSecret)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code=${encodeURIComponent(String(code))}`;

      const tokenRes = await fetch(tokenUrl);
      const tokenData: any = await tokenRes
        .json()
        .catch(() => ({}));

      if (!tokenRes.ok || !tokenData?.access_token) {
        console.error(
          "[Meta Auth] token exchange failed:",
          tokenData?.error?.message ?? "unknown"
        );
        return fail("oauth_token_exchange");
      }

      let accessToken: string =
        tokenData.access_token;

      // 2) Attempt to exchange for a long-lived Facebook token.
      try {
        const longUrl =
          `${GRAPH_API}/oauth/access_token` +
          `?grant_type=fb_exchange_token` +
          `&client_id=${encodeURIComponent(appId)}` +
          `&client_secret=${encodeURIComponent(appSecret)}` +
          `&fb_exchange_token=${encodeURIComponent(accessToken)}`;

        const longRes = await fetch(longUrl);
        const longData: any = await longRes
          .json()
          .catch(() => ({}));

        if (longRes.ok && longData?.access_token) {
          accessToken = longData.access_token;
        }
      } catch (e: any) {
        console.warn(
          "[Meta Auth] Long-lived Facebook token exchange failed:",
          e?.message
        );
      }

      const expiresAt =
        Number(tokenData.expires_in ?? 0) > 0
          ? new Date(
              Date.now() +
                Number(tokenData.expires_in) * 1000
            ).toISOString()
          : null;

      // 3) Get the Facebook Pages available to the user.
      const pagesUrl =
        `${GRAPH_API}/me/accounts` +
        `?fields=id,name,picture` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      const pagesRes = await fetch(pagesUrl);
      const pagesData: any = await pagesRes
        .json()
        .catch(() => ({}));

      if (!pagesRes.ok || pagesData?.error) {
        console.error(
          "[Meta Auth] /me/accounts failed:",
          pagesData?.error?.message ?? "unknown"
        );
        return fail("pages_fetch_failed");
      }

      const pages: any[] = pagesData.data ?? [];

      console.log(
        "[Meta Auth] /me/accounts → pages:",
        pages.length
      );

      let saved = 0;
      let lastAccountName = "";
      let lastAccountId = "";

      for (const p of pages) {
        if (!p?.id) continue;

        const pagePicture =
          typeof p.picture?.data?.url === "string"
            ? p.picture.data.url
            : null;

        const pageToken: string =
          p.access_token ?? accessToken;

        if (platform === "facebook") {
          const { error } = await db
            .from("channel_accounts")
            .upsert(
              {
                tenant_id: tenantId,
                channel: "facebook",
                external_id: String(p.id),
                display_name: p.name ?? null,
                avatar_url: pagePicture,
                status: "active",
                access_token_encrypted:
                  encryptField(pageToken),
                token_expires_at: expiresAt,
                updated_at: new Date().toISOString(),
              },
              {
                onConflict:
                  "tenant_id,channel,external_id",
              }
            );

          if (!error) {
            saved += 1;
            lastAccountName =
              p.name ?? lastAccountName;
            lastAccountId = String(p.id);
          } else {
            console.error(
              "[Meta Auth] Facebook account save failed:",
              error.message
            );
          }

          continue;
        }

        if (platform !== "instagram") continue;

        // 4) Discover the Instagram professional account
        // associated with this Facebook Page.
        const igUrl =
          `${GRAPH_API}/${p.id}` +
          `?fields=name,instagram_business_account{id,username,profile_picture_url}` +
          `&access_token=${encodeURIComponent(pageToken)}`;

        const igRes = await fetch(igUrl);
        const ig: any = await igRes
          .json()
          .catch(() => ({}));

        if (!igRes.ok || ig?.error) {
          console.warn(
            `[Meta Auth] Page ${p.id} Instagram lookup failed:`,
            ig?.error?.message ?? "unknown"
          );
          continue;
        }

        const igAcc =
          ig?.instagram_business_account;

        console.log(
          `[Meta Auth] Page ${p.id} Instagram discovery:`,
          igAcc?.id
            ? `found ${igAcc.username ?? igAcc.id}`
            : "no linked Instagram account"
        );

        if (!igAcc?.id) continue;

        const username = igAcc.username
          ? `@${igAcc.username}`
          : ig?.name ?? null;

        // Prefer the Instagram profile image returned by Meta.
        // Do not substitute the Facebook Page image: it may be
        // a different account's picture.
        const igPicture =
          typeof igAcc?.profile_picture_url === "string" &&
          igAcc.profile_picture_url.length > 0
            ? igAcc.profile_picture_url
            : typeof igAcc?.picture?.data?.url === "string"
              ? igAcc.picture.data.url
              : typeof igAcc?.picture_url === "string"
                ? igAcc.picture_url
                : null;

        if (!igPicture) {
          console.warn(
            `[Meta Auth] Instagram profile picture missing for ${igAcc.id}`
          );
        }

        const { data: taken, error: takenError } =
          await db
            .from("channel_accounts")
            .select("tenant_id, status")
            .eq("channel", "instagram")
            .eq("external_id", String(igAcc.id))
            .neq("tenant_id", tenantId)
            .eq("status", "active")
            .maybeSingle();

        if (takenError) {
          console.warn(
            "[Meta Auth] Instagram ownership lookup failed:",
            takenError.message
          );
        }

        if (taken) {
          console.warn(
            `[Meta Auth] Instagram account ${igAcc.id} already belongs to another tenant — skipped`
          );
          continue;
        }

        const { error } = await db
          .from("channel_accounts")
          .upsert(
            {
              tenant_id: tenantId,
              channel: "instagram",
              external_id: String(igAcc.id),
              display_name: username,
              avatar_url: igPicture,
              status: "active",
              access_token_encrypted:
                encryptField(pageToken),
              token_expires_at: expiresAt,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict:
                "tenant_id,channel,external_id",
            }
          );

        if (error) {
          console.error(
            "[Meta Auth] Instagram account save failed:",
            error.message
          );
          continue;
        }

        saved += 1;
        lastAccountName =
          username ?? lastAccountName;
        lastAccountId = String(igAcc.id);

        // 5) Subscribe the Facebook Page to messaging webhooks.
        console.log(
          `[Meta Auth] Subscribing Page webhooks → page: ${p.id}`
        );

        try {
          const subRes = await fetch(
            `${GRAPH_API}/${p.id}/subscribed_apps`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                access_token: pageToken,
                subscribed_fields: [
                  "messages",
                  "messaging_postbacks",
                  "messaging_seen",
                ],
              }),
            }
          );

          const subJson: any = await subRes
            .json()
            .catch(() => null);

          if (
            subRes.ok &&
            subJson &&
            (subJson.success === true ||
              subJson.result === true)
          ) {
            console.log(
              "[Meta Auth] Page webhooks subscribed"
            );
          } else {
            console.error(
              "[Meta Auth] Page webhook subscription failed:",
              `status=${subRes.status}`,
              JSON.stringify(subJson ?? "(unparseable)").slice(
                0,
                400
              )
            );
          }
        } catch (e: any) {
          console.error(
            "[Meta Auth] Page webhook subscription error:",
            e?.message ?? String(e)
          );
        }
      }

      console.log(
        "[Meta Auth] callback done — accounts saved:",
        saved,
        "platform:",
        platform
      );

      if (saved === 0) {
        return fail(
          platform === "instagram"
            ? "no_eligible_instagram — لم يُعثر على حساب Instagram احترافي مرتبط بصفحاتك"
            : "no_pages — لم تمنح صلاحيات لأي صفحة Facebook"
        );
      }

      // 6) Update or insert the channel state for the frontend.
      const {
        data: existingChannel,
        error: channelLookupError,
      } = await db
        .from("channels")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("platform", platform)
        .maybeSingle();

      if (channelLookupError) {
        console.warn(
          "[Meta Auth] channels lookup failed:",
          channelLookupError.message
        );
      }

      const channelRow = {
        is_connected: true,
        connected_at: new Date().toISOString(),
        account_name: lastAccountName || null,
        platform_account_id: lastAccountId || null,
      };

      if (existingChannel?.id) {
        const { error: chUpdErr } = await db
          .from("channels")
          .update(channelRow)
          .eq("id", existingChannel.id);

        if (chUpdErr) {
          console.warn(
            "[Meta Auth] channels update failed:",
            chUpdErr.message
          );
        } else {
          console.log(
            "[Meta Auth] channels row updated for",
            platform
          );
        }
      } else {
        const { error: chInsErr } = await db
          .from("channels")
          .insert({
            tenant_id: tenantId,
            platform,
            ...channelRow,
          });

        if (chInsErr) {
          console.warn(
            "[Meta Auth] channels insert failed:",
            chInsErr.message
          );
        } else {
          console.log(
            "[Meta Auth] channels row inserted for",
            platform
          );
        }
      }

      return res.redirect(
        `${frontBase}?channel_connected=${platform}` +
          `&accounts=${saved}` +
          `&name=${encodeURIComponent(lastAccountName)}`
      );
    } catch (e: any) {
      console.error(
        "[Meta Auth] Facebook callback error:",
        e?.message ?? e
      );

      return fail(
        e?.message
          ? String(e.message).slice(0, 120)
          : "unknown"
      );
    }
  }
);

/* ═══════════ Protected routes ═══════════ */

metaAuthRouter.use(protectedRoutes);

/* ═══════════ Start OAuth ═══════════ */

metaAuthRouter.post(
  "/facebook/start",
  async (req: any, res) => {
    const { platform } = req.body ?? {};

    if (
      platform !== "facebook" &&
      platform !== "instagram"
    ) {
      return res.status(400).json({
        error: "قناة غير مدعومة",
      });
    }

    const tenant = await ownedTenant(
      req.userId,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(403).json({
        error: "تعذر التحقق من ملكية النشاط التجاري",
      });
    }

    // Instagram Login direct flow is opt-in only.
    if (
      platform === "instagram" &&
      process.env.USE_INSTAGRAM_DIRECT_LOGIN === "true" &&
      instagramLoginConfigured()
    ) {
      let igRedirectUri: string;
      let igState: string;

      try {
        igRedirectUri = buildInstagramCallbackUrl();

        const st = await createOAuthState({
          platform,
          tenantId: tenant.id,
          userId: req.userId,
        });

        if (!st) {
          throw new Error(
            "تعذر إنشاء جلسة OAuth"
          );
        }

        igState = st.state;
      } catch (e: any) {
        console.error(
          "[Meta Auth] Instagram OAuth configuration error:",
          e?.message
        );

        return res.status(500).json({
          error: "oauth_misconfigured",
          message:
            "إعداد PUBLIC_URL/INSTAGRAM_REDIRECT_URI/الأسرار غير صحيحة على الخادم.",
        });
      }

      const igUrl =
        `${IG_AUTHORIZE}?force_reauth=true` +
        `&client_id=${encodeURIComponent(
          process.env.INSTAGRAM_APP_ID!
        )}` +
        `&redirect_uri=${encodeURIComponent(
          igRedirectUri
        )}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(
          IG_LOGIN_SCOPES.join(",")
        )}` +
        `&state=${encodeURIComponent(igState)}`;

      console.log(
        "[Meta Auth] Using direct Instagram Login →",
        igRedirectUri
      );

      return res.json({ url: igUrl });
    }

    // Facebook Login flow.
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    if (!appId || !appSecret) {
      return res.status(400).json({
        error: "oauth_not_configured",
        message:
          "تطبيق Meta غير مُهيّأ على الخادم بعد.",
      });
    }

    let redirectUri: string;
    let state: string;

    try {
      redirectUri = buildMetaCallbackUrl();

      const st = await createOAuthState({
        platform,
        tenantId: tenant.id,
        userId: req.userId,
      });

      if (!st) {
        throw new Error(
          "تعذر إنشاء جلسة OAuth"
        );
      }

      state = st.state;
    } catch (e: any) {
      console.error(
        "[Meta Auth] OAuth configuration error:",
        e?.message
      );

      return res.status(500).json({
        error: "oauth_misconfigured",
        message:
          "إعداد PUBLIC_URL/الأسرار غير صحيحة على الخادم.",
      });
    }

    console.log(
      "[Meta Auth] OAuth start → redirect_uri:",
      redirectUri,
      "platform:",
      platform
    );

    const scopes = SCOPES[platform];

    const url =
      `https://www.facebook.com/v21.0/dialog/oauth` +
      `?client_id=${encodeURIComponent(appId)}` +
      `&redirect_uri=${encodeURIComponent(
        redirectUri
      )}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(
        scopes.join(",")
      )}` +
      `&response_type=code`;

    return res.json({ url });
  }
);

/* ═══════════ Disconnect channel ═══════════ */

metaAuthRouter.post(
  "/disconnect",
  async (req: any, res) => {
    const { platform } = req.body ?? {};

    if (
      platform !== "facebook" &&
      platform !== "instagram"
    ) {
      return res.status(400).json({
        error: "قناة غير مدعومة",
      });
    }

    const tenant = await ownedTenant(
      req.userId,
      req.body?.tenantId
    );

    if (!tenant) {
      return res.status(403).json({
        error: "تعذر التحقق من ملكية النشاط",
      });
    }

    const { error: accountError } = await db
      .from("channel_accounts")
      .update({
        status: "disconnected",
        access_token_encrypted: null,
        updated_at: new Date().toISOString(),
      })
      .eq("tenant_id", tenant.id)
      .eq("channel", platform);

    if (accountError) {
      console.error(
        "[Meta Auth] Disconnect account update failed:",
        accountError.message
      );

      return res.status(500).json({
        error: "disconnect_failed",
      });
    }

    const { error: channelError } = await db
      .from("channels")
      .update({
        is_connected: false,
        account_name: null,
        account_avatar: null,
        platform_account_id: null,
      })
      .eq("tenant_id", tenant.id)
      .eq("platform", platform);

    if (channelError) {
      console.error(
        "[Meta Auth] Disconnect channel update failed:",
        channelError.message
      );

      return res.status(500).json({
        error: "disconnect_failed",
      });
    }

    return res.json({ ok: true });
  }
);
