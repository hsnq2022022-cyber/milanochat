/**
 * S1: WhatsApp phone_number_id binding that can NEVER take over another
 * tenant's number.
 *
 *  1. Refuse when channel_accounts already holds a WhatsApp account with this
 *     external_id for ANOTHER tenant (any status).
 *  2. INSERT INTO wa_bindings ... ON CONFLICT (phone_id) DO NOTHING
 *     (supabase-js upsert with ignoreDuplicates) — an existing row is never
 *     updated, so there is no check-then-write race on wa_bindings.
 *  3. Read the row back: owner == caller -> ok (idempotent re-bind),
 *     owner != caller -> conflict (409, manual support), missing -> error.
 *
 * No data about the other tenant leaves this module; callers log only the
 * coarse status.
 */

export type BindStore = {
  /** true when channel_accounts has a whatsapp account with this id for another tenant */
  foreignWhatsappAccount(phoneId: string, tenantId: string): Promise<boolean>;
  /** INSERT ... ON CONFLICT (phone_id) DO NOTHING */
  insertIfAbsent(phoneId: string, tenantId: string): Promise<void>;
  ownerOf(phoneId: string): Promise<string | null>;
};

export type BindResult = { status: "bound" } | { status: "conflict" } | { status: "error" };

export const BIND_CONFLICT_BODY = {
  error:
    "هذا الرقم مرتبط بحساب آخر ولا يمكن نقله تلقائيًا — تواصل مع الدعم الفني للتحقق اليدوي. / " +
    "This WhatsApp number is already linked to another account; manual support intervention is required.",
  code: "PHONE_ID_ALREADY_BOUND",
} as const;

export async function bindWhatsappNumber(store: BindStore, tenantId: string, phoneId: string): Promise<BindResult> {
  try {
    if (await store.foreignWhatsappAccount(phoneId, tenantId)) return { status: "conflict" };
    await store.insertIfAbsent(phoneId, tenantId);
    const owner = await store.ownerOf(phoneId);
    if (owner === null) return { status: "error" };
    return owner === tenantId ? { status: "bound" } : { status: "conflict" };
  } catch {
    return { status: "error" };
  }
}

type Q = any; // supabase-js query builder (kept untyped: pure module, no npm import)

/** Adapter over the service-role supabase-js client. */
export function supabaseBindStore(sb: { from(table: string): Q }): BindStore {
  return {
    async foreignWhatsappAccount(phoneId, tenantId) {
      const { data, error } = await sb
        .from("channel_accounts")
        .select("tenant_id")
        .eq("channel", "whatsapp")
        .eq("external_id", phoneId)
        .neq("tenant_id", tenantId)
        .limit(1);
      if (error) throw new Error("channel_accounts_lookup");
      return Array.isArray(data) && data.length > 0;
    },
    async insertIfAbsent(phoneId, tenantId) {
      const { error } = await sb
        .from("wa_bindings")
        .upsert({ phone_id: phoneId, tenant_id: tenantId }, { onConflict: "phone_id", ignoreDuplicates: true });
      if (error) throw new Error("wa_bindings_insert");
    },
    async ownerOf(phoneId) {
      const { data, error } = await sb.from("wa_bindings").select("tenant_id").eq("phone_id", phoneId).maybeSingle();
      if (error) throw new Error("wa_bindings_read");
      return data && typeof data.tenant_id === "string" ? data.tenant_id : null;
    },
  };
}
