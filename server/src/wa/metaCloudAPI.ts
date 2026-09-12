/**
 * Meta WhatsApp Cloud API Provider
 * 
 * تنفيذ رسمي لـ WhatsApp باستخدام Meta Cloud API
 * لا يستخدم Baileys أو QR أو WhatsApp Web
 */

import type { WhatsAppProvider, IncomingMessage, MessageStatus } from './provider.js';
import { config } from '../config.js';

const GRAPH_API_BASE = 'https://graph.facebook.com';

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

    if (!this.config.accessToken || !this.config.phoneNumberId) {
      console.warn('[MetaCloudAPI] Missing Meta configuration - WhatsApp Cloud API will not work');
    }
  }

  /**
   * إرسال رسالة نصية عبر Meta Cloud API
   */
  async sendMessage(tenantId: string, chatId: string, text: string): Promise<string> {
    const url = `${GRAPH_API_BASE}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: chatId,
      type: 'text',
      text: {
        body: text,
      },
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('[MetaCloudAPI] Send message failed:', errorData);
        throw new Error(`Meta API error: ${errorData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const messageId = data.messages?.[0]?.id;

      if (!messageId) {
        throw new Error('No message ID returned from Meta API');
      }

      console.log(`[MetaCloudAPI] Message sent to ${chatId}, ID: ${messageId}`);
      return messageId;
    } catch (error) {
      console.error('[MetaCloudAPI] Error sending message:', error);
      throw error;
    }
  }

  /**
   * إرسال رسالة template
   */
  async sendTemplate(
    tenantId: string,
    chatId: string,
    templateName: string,
    language: string,
    parameters?: Array<{ type: string; text?: string }>
  ): Promise<string> {
    const url = `${GRAPH_API_BASE}/${this.config.graphApiVersion}/${this.config.phoneNumberId}/messages`;

    const payload: any = {
      messaging_product: 'whatsapp',
      to: chatId,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: language,
        },
      },
    };

    if (parameters && parameters.length > 0) {
      payload.template.components = [
        {
          type: 'body',
          parameters: parameters,
        },
      ];
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Meta API error: ${errorData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      return data.messages?.[0]?.id;
    } catch (error) {
      console.error('[MetaCloudAPI] Error sending template:', error);
      throw error;
    }
  }

  /**
   * التحقق من حالة الاتصال
   * في Cloud API، الاتصال دائم طالما الـ token صالح
   */
  async isConnected(tenantId: string): Promise<boolean> {
    // في Cloud API، نتحقق من صلاحية الـ token
    if (!this.config.accessToken || !this.config.phoneNumberId) {
      return false;
    }

    try {
      const url = `${GRAPH_API_BASE}/${this.config.graphApiVersion}/${this.config.phoneNumberId}`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`,
        },
      });

      return response.ok;
    } catch (error) {
      console.error('[MetaCloudAPI] Error checking connection:', error);
      return false;
    }
  }

  /**
   * الحصول على معلومات الاتصال
   */
  async getConnectionInfo(tenantId: string): Promise<{
    connected: boolean;
    phoneNumber?: string;
    provider: 'baileys' | 'meta-cloud-api';
  }> {
    const connected = await this.isConnected(tenantId);

    return {
      connected,
      provider: 'meta-cloud-api',
    };
  }

  /**
   * التحقق من Webhook signature (للأمان)
   */
  verifyWebhookSignature(signature: string, payload: string): boolean {
    // في الإنتاج، يجب التحقق من HMAC signature
    // هذا مثال مبسط - في الإنتاج استخدم crypto.createHmac
    return true; // TODO: Implement proper signature verification
  }

  /**
   * معالجة Webhook verification (GET request)
   */
  handleWebhookVerification(mode: string, token: string, challenge: string): string | null {
    if (mode === 'subscribe' && token === this.config.verifyToken) {
      console.log('[MetaCloudAPI] Webhook verified successfully');
      return challenge;
    }
    return null;
  }

  /**
   * معالجة الرسائل الواردة من Webhook
   */
  parseIncomingWebhook(body: any): { messages: IncomingMessage[], statuses: MessageStatus[] } {
    const messages: IncomingMessage[] = [];
    const statuses: MessageStatus[] = [];

    if (!body.entry || !Array.isArray(body.entry)) {
      return { messages, statuses };
    }

    for (const entry of body.entry) {
      if (!entry.changes || !Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // معالجة الرسائل الواردة
        if (value.messages && Array.isArray(value.messages)) {
          for (const message of value.messages) {
            if (message.type === 'text' && message.text?.body) {
              messages.push({
                tenantId: '', // سيتم تعيينه لاحقاً بناءً على phone number
                chatId: message.from,
                text: message.text.body,
                messageId: message.id,
                timestamp: parseInt(message.timestamp) * 1000,
                fromMe: false,
              });
            }
          }
        }

        // معالجة تحديثات الحالة
        if (value.statuses && Array.isArray(value.statuses)) {
          for (const status of value.statuses) {
            statuses.push({
              messageId: status.id,
              status: this.mapStatus(status.status),
              timestamp: parseInt(status.timestamp) * 1000,
            });
          }
        }
      }
    }

    return { messages, statuses };
  }

  /**
   * تحويل حالة Meta إلى حالة موحدة
   */
  private mapStatus(metaStatus: string): 'sent' | 'delivered' | 'read' | 'failed' {
    switch (metaStatus) {
      case 'sent':
        return 'sent';
      case 'delivered':
        return 'delivered';
      case 'read':
        return 'read';
      case 'failed':
        return 'failed';
      default:
        return 'sent';
    }
  }
}

// Singleton instance
export const metaCloudAPI = new MetaCloudAPIProvider();
