/**
 * عميل Supabase للمتصفح (Auth فقط — البيانات تمر عبر الخادم بتوكن الجلسة).
 * بدون متغيرات البيئة يعمل كل شيء بوضع العرض التجريبي.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const env = ((import.meta as any).env ?? {}) as Record<string, string | undefined>;
const URL_ = env.VITE_SUPABASE_URL ?? "";
const ANON = env.VITE_SUPABASE_ANON_KEY ?? "";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!URL_ || !ANON) return null;
  if (!client) client = createClient(URL_, ANON);
  return client;
}

/** مفتاح رمز الضم الذي يحفظه معالج الإنشاء في الصفحة الرئيسية */
export const CLAIM_STORAGE_KEY = "milano_claim";
export const getStoredClaim = () => localStorage.getItem(CLAIM_STORAGE_KEY);
export const clearStoredClaim = () => localStorage.removeItem(CLAIM_STORAGE_KEY);
