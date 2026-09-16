/**
 * WhatsApp Provider Interface
 * 
 * يوفر abstraction layer لفصل منطق التطبيق عن طريقة الاتصال بـ WhatsApp
 * يمكن تبديل التنفيذ بين Baileys (QR) و Meta Cloud API دون تغيير بقية الكود
 */

export interface WhatsAppProvider {
  /**
   * إرسال رسالة نصية
   * @param tenantId - معرف العميل
   * @param chatId - رقم الهاتف أو chat ID
   * @param text - نص الرسالة
   * @returns Promise يحتوي على message ID من المزود
   */
  sendMessage(tenantId: string, chatId: string, text: string): Promise<string>;

  /**
   * إرسال رسالة template
   * @param tenantId - معرف العميل
   * @param chatId - رقم الهاتف
   * @param templateName - اسم القالب
   * @param language - لغة القالب
   * @param parameters - معاملات القالب
   */
  sendTemplate?(
    tenantId: string,
    chatId: string,
    templateName: string,
    language: string,
    parameters?: Array<{ type: string; text?: string }>
  ): Promise<string>;

  /**
   * التحقق من حالة الاتصال
   */
  isConnected(tenantId: string): Promise<boolean>;

  /**
   * الحصول على معلومات الاتصال
   */
  getConnectionInfo(tenantId: string): Promise<{
    connected: boolean;
    phoneNumber?: string;
    provider: 'baileys' | 'meta-cloud-api';
  }>;
}

export interface IncomingMessage {
  tenantId: string;
  chatId: string;
  text: string;
  messageId: string;
  timestamp: number;
  fromMe: boolean;
  phoneNumberId?: string; // Meta Cloud API phone_number_id من metadata
  customerName?: string | null; // اسم العميل من WhatsApp Profile
}

export interface MessageStatus {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: number;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
export type StatusHandler = (status: MessageStatus) => Promise<void>;
