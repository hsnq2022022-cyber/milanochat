import type { Request, Response, NextFunction } from "express";

/**
 * محدّد معدل بسيط (نافذة ثابتة، في الذاكرة).
 * كافٍ لحماية الـ webhooks ومسارات QR من الإغراق؛
 * للإنتاج متعدد النسخ استخدم Redis لاحقًا.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // تنظيف دوري حتى لا تنمو الخريطة بلا حد
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, opts.windowMs).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = opts.key ? opts.key(req) : (req.ip ?? "unknown");
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      res.setHeader("retry-after", Math.ceil((entry.resetAt - now) / 1000).toString());
      return res.status(429).json({ error: "طلبات كثيرة — حاول بعد قليل" });
    }
    next();
  };
}
