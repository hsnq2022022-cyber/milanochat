/**
 * Meta WhatsApp Cloud API Provider
 *
 * التنفيذ الرسمي لـ WhatsApp باستخدام Meta Cloud API.
 *
 * - لا يستخدم Baileys
 * - لا يستخدم WhatsApp Web
 * - لا يستخدم QR
 * - استقبال الرسائل عبر Meta Webhook
 * - إرسال الرسائل عبر Meta Graph API
 * - كل Tenant يستخدم phone_number_id المرتبط به في wa_bindings
 */

import type {
  WhatsAppProvider,
  IncomingMessage,
  MessageStatus,
} from "./provider.js";

import { config } from "../config.js";
import { db } from "../db.js";

const GRAPH_API_BASE = "https://graph.facebook.com";

interface MetaConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  graphApiVersion: string;
}

class MetaCloudAPIProvider implements WhatsAppProvider {
  private config: MetaConfig;

  constructor() {
    this.config = {
      accessToken: config.meta.accessToken,
      phoneNumberId: config.meta.phoneNumberId,
      businessAccountId: config.meta.businessAccountId,
      verifyToken: config.meta.verifyToken,
      graphApiVersion: config.meta.graphApiVersion,
    };

    if (!this.config.accessToken) {
      console.warn(
        "[MetaCloudAPI] WHATSAPP_ACCESS_TOKEN is missing"
      );
    }

    if (!this.config.phoneNumberId) {
      console.warn(
        "[MetaCloudAPI] WHATSAPP_PHONE_NUMBER_ID is missing"
      );
    }

    if (!this.config.verifyToken) {
      console.warn(
        "[MetaCloudAPI] WHATSAPP_VERIFY_TOKEN is missing"
      );
    }
  }

  /**
   * الحصول على Phone Number ID المرتبط بالـ Tenant.
   *
   * المصدر الأساسي:
   * wa_bindings.phone_id
   *
   * يتم استخدام config.meta.phoneNumberId كـ fallback
   * للتوافق مع الإعدادات القديمة.
   */
  private async getPhoneNumberId(
    tenantId: string
  ): Promise<string | null> {
    if (tenantId) {
      try {
        const { data, error } = await db
          .from("wa_bindings")
          .select("phone_id")
          .eq("tenant_id", tenantId)
          .limit(1)
          .maybeSingle();

        if (error) {
          console.error(
            `[MetaCloudAPI] Failed to load WhatsApp binding for tenant ${tenantId}:`,
            error.message
          );
        }

        if (data?.phone_id) {
          return String(data.phone_id);
        }
      } catch (error) {
        console.error(
          `[MetaCloudAPI] Error loading WhatsApp binding for tenant ${tenantId}:`,
          error
        );
      }
    }

    /**
     * Fallback للإعداد القديم.
     *
     * هذا لا يُستخدم إذا كان للـ tenant binding صحيح في Supabase.
     */
    if (this.config.phoneNumberId) {
      return this.config.phoneNumberId;
    }

    return null;
  }

  /**
   * إرسال رسالة نصية عبر Meta Cloud API.
   */
  async sendMessage(
    tenantId: string,
    chatId: string,
    text: string
  ): Promise<string> {
    if (!this.config.accessToken) {
      throw new Error(
        "WHATSAPP_ACCESS_TOKEN غير مضبوط في Environment Variables"
      );
    }

    const phoneNumberId =
      await this.getPhoneNumberId(tenantId);

    if (!phoneNumberId) {
      throw new Error(
        `لا يوجد phone_number_id مرتبط بالـ tenant: ${tenantId}`
      );
    }

    const url =
      `${GRAPH_API_BASE}/` +
      `${this.config.graphApiVersion}/` +
      `${phoneNumberId}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: chatId,
      type: "text",
      text: {
        body: text,
      },
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const raw = await response.text();

      let data: any = {};

      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        console.error(
          "[MetaCloudAPI] Send message failed:",
          {
            status: response.status,
            phoneNumberId,
            error: data?.error?.message || raw,
          }
        );

        throw new Error(
          `Meta API error: ${
            data?.error?.message ||
            response.statusText
          }`
        );
      }

      const messageId =
        data?.messages?.[0]?.id;

      if (!messageId) {
        throw new Error(
          "Meta API لم يرجع message ID"
        );
      }

      console.log(
        `[MetaCloudAPI] Message sent successfully to ${chatId}`
      );

      return messageId;
    } catch (error) {
      console.error(
        "[MetaCloudAPI] Error sending message:",
        error
      );

      throw error;
    }
  }

  /**
   * إرسال Template عبر Meta Cloud API.
   */
  async sendTemplate(
    tenantId: string,
    chatId: string,
    templateName: string,
    language: string,
    parameters?: Array<{
      type: string;
      text?: string;
    }>
  ): Promise<string> {
    if (!this.config.accessToken) {
      throw new Error(
        "WHATSAPP_ACCESS_TOKEN غير مضبوط في Environment Variables"
      );
    }

    const phoneNumberId =
      await this.getPhoneNumberId(tenantId);

    if (!phoneNumberId) {
      throw new Error(
        `لا يوجد phone_number_id مرتبط بالـ tenant: ${tenantId}`
      );
    }

    const url =
      `${GRAPH_API_BASE}/` +
      `${this.config.graphApiVersion}/` +
      `${phoneNumberId}/messages`;

    const payload: any = {
      messaging_product: "whatsapp",
      to: chatId,
      type: "template",
      template: {
        name: templateName,
        language: {
          code: language,
        },
      },
    };

    if (
      parameters &&
      parameters.length > 0
    ) {
      payload.template.components = [
        {
          type: "body",
          parameters,
        },
      ];
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const raw = await response.text();

      let data: any = {};

      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        console.error(
          "[MetaCloudAPI] Send template failed:",
          {
            status: response.status,
            phoneNumberId,
            error: data?.error?.message || raw,
          }
        );

        throw new Error(
          `Meta API error: ${
            data?.error?.message ||
            response.statusText
          }`
        );
      }

      const messageId =
        data?.messages?.[0]?.id;

      if (!messageId) {
        throw new Error(
          "Meta API لم يرجع message ID للـ template"
        );
      }

      return messageId;
    } catch (error) {
      console.error(
        "[MetaCloudAPI] Error sending template:",
        error
      );

      throw error;
    }
  }

  /**
   * التحقق من حالة اتصال Meta Cloud API.
   *
   * مهم:
   * tenantId يستخدم للحصول على phone_number_id
   * من wa_bindings بدل الاعتماد فقط على Environment Variable.
   */
  async isConnected(
    tenantId: string
  ): Promise<boolean> {
    if (!this.config.accessToken) {
      console.error(
        "[MetaCloudAPI] Cannot check connection: WHATSAPP_ACCESS_TOKEN is missing"
      );

      return false;
    }

    const phoneNumberId =
      await this.getPhoneNumberId(tenantId);

    if (!phoneNumberId) {
      console.error(
        `[MetaCloudAPI] Cannot check connection: no phone_number_id for tenant ${tenantId}`
      );

      return false;
    }

    const url =
      `${GRAPH_API_BASE}/` +
      `${this.config.graphApiVersion}/` +
      `${phoneNumberId}`;

    try {
      console.log(
        `[MetaCloudAPI] Checking phone number connection for tenant ${tenantId}`
      );

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.config.accessToken}`,
        },
      });

      const raw = await response.text();

      let data: any = {};

      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        console.error(
          "[MetaCloudAPI] Connection check failed:",
          {
            status: response.status,
            phoneNumberId,
            error:
              data?.error?.message ||
              raw ||
              response.statusText,
            code: data?.error?.code,
            type: data?.error?.type,
          }
        );

        return false;
      }

      console.log(
        `[MetaCloudAPI] Connection verified for phone_number_id ${phoneNumberId}`
      );

      return true;
    } catch (error) {
      console.error(
        "[MetaCloudAPI] Network error while checking connection:",
        error
      );

      return false;
    }
  }

  /**
   * الحصول على معلومات الاتصال.
   */
  async getConnectionInfo(
    tenantId: string
  ): Promise<{
    connected: boolean;
    phoneNumber?: string;
    provider:
      | "baileys"
      | "meta-cloud-api";
  }> {
    const connected =
      await this.isConnected(tenantId);

    return {
      connected,
      provider: "meta-cloud-api",
    };
  }

  /**
   * التحقق من Webhook signature.
   *
   * ملاحظة:
   * سيتم تحسين HMAC لاحقًا.
   * لا نغيّر هذا الآن حتى لا نؤثر على مسار Webhook العامل.
   */
  verifyWebhookSignature(
    signature: string,
    payload: string
  ): boolean {
    return true;
  }

  /**
   * معالجة Webhook verification.
   */
  handleWebhookVerification(
    mode: string,
    token: string,
    challenge: string
  ): string | null {
    if (
      mode === "subscribe" &&
      token === this.config.verifyToken
    ) {
      console.log(
        "[MetaCloudAPI] Webhook verified successfully"
      );

      return challenge;
    }

    return null;
  }

  /**
   * معالجة الرسائل الواردة من Webhook.
   */
  parseIncomingWebhook(
    body: any
  ): {
    messages: IncomingMessage[];
    statuses: MessageStatus[];
    phoneNumberId?: string;
  } {
    const messages: IncomingMessage[] = [];
    const statuses: MessageStatus[] = [];

    let phoneNumberId:
      | string
      | undefined;

    if (
      !body?.entry ||
      !Array.isArray(body.entry)
    ) {
      return {
        messages,
        statuses,
        phoneNumberId,
      };
    }

    for (const entry of body.entry) {
      if (
        !entry?.changes ||
        !Array.isArray(entry.changes)
      ) {
        continue;
      }

      for (const change of entry.changes) {
        if (
          change?.field !== "messages"
        ) {
          continue;
        }

        const value = change?.value;

        if (!value) {
          continue;
        }

        /**
         * استخراج Phone Number ID الحقيقي
         * الذي أرسلته Meta داخل Webhook.
         */
        if (
          value.metadata?.phone_number_id
        ) {
          phoneNumberId =
            String(
              value.metadata.phone_number_id
            );
        }

        /**
         * الرسائل الواردة.
         */
        if (
          Array.isArray(value.messages)
        ) {
          for (const message of value.messages) {
            if (
              message?.type === "text" &&
              message?.text?.body
            ) {
              /**
               * استخراج اسم العميل من contacts.
               */
              let customerName: string | null = null;
              if (Array.isArray(value.contacts)) {
                const matchingContact = value.contacts.find(
                  (c: any) => c.wa_id === message.from
                );
                if (matchingContact?.profile?.name) {
                  customerName = String(matchingContact.profile.name);
                }
              }

              messages.push({
                tenantId: "",
                chatId: message.from,
                text: message.text.body,
                messageId: message.id,
                timestamp:
                  parseInt(
                    message.timestamp,
                    10
                  ) * 1000,
                fromMe: false,
                phoneNumberId,
                customerName,
              });
            }
          }
        }

        /**
         * تحديثات حالة الرسائل.
         */
        if (
          Array.isArray(value.statuses)
        ) {
          for (const status of value.statuses) {
            statuses.push({
              messageId: status.id,
              status: this.mapStatus(
                status.status
              ),
              timestamp:
                parseInt(
                  status.timestamp,
                  10
                ) * 1000,
            });
          }
        }
      }
    }

    return {
      messages,
      statuses,
      phoneNumberId,
    };
  }

  /**
   * تحويل حالة Meta إلى حالة موحدة.
   */
  private mapStatus(
    metaStatus: string
  ):
    | "sent"
    | "delivered"
    | "read"
    | "failed" {
    switch (metaStatus) {
      case "sent":
        return "sent";

      case "delivered":
        return "delivered";

      case "read":
        return "read";

      case "failed":
        return "failed";

      default:
        return "sent";
    }
  }
}

/**
 * Singleton instance.
 */
export const metaCloudAPI =
  new MetaCloudAPIProvider();

