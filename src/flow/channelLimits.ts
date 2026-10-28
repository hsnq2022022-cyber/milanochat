/** Meta provider messaging rules change and vary by message type.
 * TODO(verify): Read the current Meta policy for each channel BEFORE
 * enforcing numeric windows or permitting any scheduled provider delivery.
 * Messenger: https://developers.facebook.com/docs/messenger-platform/send-messages/
 * Instagram: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/
 * WhatsApp: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages/
 * URLs are references awaiting review; no numeric assumptions are baked in.
 */
import type { FlowData } from "./model";

export function delaySafetyWarning(
  value:number,
  unit:FlowData["delayUnit"],
):string {
  if(!Number.isFinite(value)||value<=0)return "مدة الانتظار غير صالحة.";
  return "تحذير: الانتظار لمدة "+value+" "+unit+
    " قد يقع خارج نافذة مراسلة Meta لهذه القناة. يجب التحقق من النافذة ونوع الرسالة قبل النشر. "+
    "المحاكاة لا ترسل رسائل فعلية.";
}
