/**
 * مسارات Widgets — CRUD + تشغيل الـ widget (إرسال/استقبال رسائل)
 */

import { Router } from "express";
import type {
  Request,
  Response,
  NextFunction,
} from "express";

import { authClient, db } from "../db.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { answerFromKnowledge } from "../rag/qa.js";
import {
  chatCompletion,
  embed,
  toPgVector,
} from "../llm.js";

// ═══════════════════════════════════════════════════════════════════════════════
// دوال مساعدة لتحليل المواقع
// ═══════════════════════════════════════════════════════════════════════════════

function extractColors(text: string): {
  primary: string;
  secondary: string;
  background: string;
  text: string;
} {
  const hexColors =
    text.match(/#[0-9a-fA-F]{6}/g) || [];

  const rgbColors =
    text.match(
      /rgb\(\d+,\s*\d+,\s*\d+\)/g
    ) || [];

  void rgbColors;

  let primary = "#2ec27e";
  let secondary = "#e8b24b";
  let background = "#ffffff";
  let textColor = "#1a1a1a";

  if (hexColors.length > 0) {
    primary = hexColors[0];

    if (hexColors.length > 1) {
      secondary = hexColors[1];
    }
  }

  if (
    text.includes("background: #000") ||
    text.includes("background-color: #000")
  ) {
    background = "#1a1a1a";
    textColor = "#ffffff";
  }

  return {
    primary,
    secondary,
    background,
    text: textColor,
  };
}

function extractFontFamily(
  text: string
): string {
  const fontMatch = text.match(
    /font-family:\s*['"]?([^'";]+)/
  );

  if (fontMatch) {
    const font =
      fontMatch[1].toLowerCase();

    if (font.includes("cairo")) {
      return "Cairo";
    }

    if (font.includes("tajawal")) {
      return "Tajawal";
    }

    if (font.includes("ibm")) {
      return "IBM Plex Arabic";
    }
  }

  return "Cairo";
}

function extractBorderRadius(
  text: string
): number {
  const radiusMatch = text.match(
    /border-radius:\s*(\d+)/
  );

  if (radiusMatch) {
    return Math.min(
      parseInt(radiusMatch[1]),
      32
    );
  }

  return 12;
}

function extractLogo(
  text: string
): string | undefined {
  const ogImage = text.match(
    /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/
  );

  if (ogImage) {
    return ogImage[1];
  }

  const icon = text.match(
    /<link[^>]*rel="icon"[^>]*href="([^"]+)"/
  );

  if (icon) {
    return icon[1];
  }

  return undefined;
}

async function generateWelcomeMessage(
  siteName: string,
  content: string
): Promise<string> {
  try {
    const prompt = `بناءً على اسم الموقع "${siteName}" والمحتوى التالي، اكتب رسالة ترحيب قصيرة وودية (جملة واحدة) للعملاء:

${content.slice(0, 500)}

اكتب الرسالة فقط بدون أي شرح إضافي.`;

    const response =
      await chatCompletion(
        "أنت مساعد في كتابة رسائل ترحيب احترافية باللغة العربية.",
        prompt,
        {
          json: false,
        }
      );

    return (
      response.trim() ||
      "مرحباً! كيف يمكنني مساعدتك؟"
    );
  } catch {
    return "مرحباً! كيف يمكنني مساعدتك؟";
  }
}

export const widgetsRouter =
  Router();

type AuthedRequest = Request & {
  userId?: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// المصادقة
// ═══════════════════════════════════════════════════════════════════════════════

/** التحقق من توكن Supabase Auth */
async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header =
    req.headers.authorization ?? "";

  const token =
    header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      error: "غير مصرح",
    });
  }

  const {
    data,
    error,
  } = await authClient.auth.getUser(
    token
  );

  if (error || !data?.user) {
    return res.status(401).json({
      error: "جلسة غير صالحة",
    });
  }

  (
    req as AuthedRequest
  ).userId = data.user.id;

  next();
}

/** تحميل tenant يملكه المستخدم */
async function ownedTenant(
  userId: string,
  tenantId?: string
) {
  if (tenantId) {
    const { data } = await db
      .from("tenants")
      .select("*")
      .eq("id", tenantId)
      .eq("user_id", userId)
      .maybeSingle();

    return data;
  }

  const { data } = await db
    .from("tenants")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// مسارات لوحة التحكم
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.use(
  "/dashboard",
  requireAuth
);

// ═══════════════════════════════════════════════════════════════════════════════
// قائمة Widgets
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.get(
  "/dashboard",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    let tenant =
      await ownedTenant(
        userId,
        req.query.tenantId as string
      );

    if (!tenant) {
      const {
        data: newTenant,
        error,
      } = await db
        .from("tenants")
        .insert({
          user_id: userId,
          business_name: "مشروعي",
          source_type: "manual",
          credits_remaining: 1000,
          is_active: true,
          activated_at:
            new Date().toISOString(),
        })
        .select()
        .single();

      if (error || !newTenant) {
        return res.status(500).json({
          error: "تعذر إنشاء حساب",
        });
      }

      tenant = newTenant;
    }

    const {
      data,
      error,
    } = await db
      .from("widgets")
      .select("*")
      .eq("tenant_id", tenant.id)
      .order("created_at", {
        ascending: false,
      });

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    res.json(data ?? []);
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// إنشاء Widget
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/dashboard",
  rateLimit({
    windowMs: 60_000,
    max: 10,
  }),
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    let tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      const {
        data: newTenant,
        error,
      } = await db
        .from("tenants")
        .insert({
          user_id: userId,
          business_name: "مشروعي",
          source_type: "manual",
          credits_remaining: 1000,
          is_active: true,
          activated_at:
            new Date().toISOString(),
        })
        .select()
        .single();

      if (error || !newTenant) {
        return res.status(500).json({
          error: "تعذر إنشاء حساب",
        });
      }

      tenant = newTenant;
    }

    const {
      name,
      settings,
    } = req.body ?? {};

    if (!name?.trim()) {
      return res.status(400).json({
        error: "اسم الـ widget مطلوب",
      });
    }

    const insertData: Record<
      string,
      any
    > = {
      tenant_id: tenant.id,
      name: name.trim(),
    };

    if (
      settings &&
      typeof settings === "object" &&
      settings.appearance
    ) {
      /*
       * settings هو المصدر الأساسي لإعدادات
       * الـ Widget بالكامل.
       */
      insertData.settings = settings;

      insertData.welcome_message =
        settings.chat?.welcomeMessage ??
        "مرحباً! كيف يمكنني مساعدتك؟";

      insertData.primary_color =
        settings.appearance?.primaryColor ??
        "#2ec27e";

      insertData.header_color =
        settings.appearance?.headerColor ??
        settings.appearance?.primaryColor ??
        "#2ec27e";

      insertData.text_color =
        settings.appearance?.textColor ??
        "#ffffff";

      insertData.position =
        settings.appearance?.position ??
        "left";

      insertData.language =
        settings.localization?.language ??
        "ar";

      insertData.rtl =
        settings.localization?.rtl ??
        true;

      insertData.show_branding =
        settings.branding?.showBranding ??
        true;

      insertData.placeholder =
        settings.chat?.placeholder ??
        "اكتب رسالتك...";

      /*
       * حفظ روابط الصور في الأعمدة القديمة
       * إن كانت موجودة في settings.
       */
      insertData.avatar_url =
        settings.avatar?.botAvatar?.url ??
        null;

      insertData.logo_url =
        settings.avatar?.headerLogo?.url ??
        null;

      /*
       * لا نستخدم agent_name لأن العمود
       * غير موجود في قاعدة البيانات الحالية.
       *
       * اسم المساعد محفوظ داخل settings.
       */

      insertData.agent_tagline =
        settings.avatar?.botTagline ??
        "يرد خلال ثوانٍ";

      insertData.border_radius =
        settings.appearance?.borderRadius ??
        16;

      insertData.shadow =
        settings.appearance?.shadow ??
        "medium";

      insertData.window_width =
        settings.appearance?.width ??
        380;

      insertData.window_height =
        settings.appearance?.height ??
        560;

      insertData.launcher_size =
        settings.appearance?.launcher?.size ??
        60;

      insertData.launcher_shape =
        settings.appearance?.launcher?.shape ??
        "circle";

      insertData.launcher_icon_url =
        settings.appearance?.launcher?.customIcon ??
        null;

      insertData.show_status =
        settings.chatWindow?.header?.showStatus ??
        true;

      insertData.show_timestamps =
        settings.chatWindow?.bubbles?.showTimestamp ??
        true;

      insertData.typing_indicator =
        settings.chat?.showTypingIndicator ??
        true;
    } else {
      /*
       * دعم الصيغة القديمة للإعدادات.
       */
      insertData.settings =
        settings ?? {};

      insertData.welcome_message =
        settings?.welcomeMessage ??
        "مرحباً! كيف يمكنني مساعدتك؟";

      insertData.primary_color =
        settings?.primaryColor ??
        "#2ec27e";

      insertData.header_color =
        settings?.headerColor ??
        settings?.primaryColor ??
        "#2ec27e";

      insertData.text_color =
        settings?.textColor ??
        "#ffffff";

      insertData.position =
        settings?.position ??
        "left";

      insertData.language =
        settings?.language ??
        "ar";

      insertData.rtl =
        settings?.rtl ??
        true;

      insertData.avatar_url =
        settings?.avatarUrl ??
        null;

      insertData.logo_url =
        settings?.logoUrl ??
        null;

      /*
       * لا نستخدم agent_name.
       */
      insertData.agent_tagline =
        settings?.agentTagline ??
        "يرد خلال ثوانٍ";

      insertData.show_branding =
        settings?.showBranding ??
        true;

      insertData.placeholder =
        settings?.placeholder ??
        "اكتب رسالتك...";

      insertData.suggested_questions =
        settings?.suggestedQuestions ??
        [];

      insertData.border_radius =
        settings?.borderRadius ??
        16;

      insertData.shadow =
        settings?.shadow ??
        "medium";

      insertData.window_width =
        settings?.windowWidth ??
        380;

      insertData.window_height =
        settings?.windowHeight ??
        560;

      insertData.launcher_size =
        settings?.launcherSize ??
        60;

      insertData.launcher_shape =
        settings?.launcherShape ??
        "circle";

      insertData.launcher_icon_url =
        settings?.launcherIconUrl ??
        null;

      insertData.show_status =
        settings?.showStatus ??
        true;

      insertData.show_timestamps =
        settings?.showTimestamps ??
        true;

      insertData.typing_indicator =
        settings?.typingIndicator ??
        true;
    }

    const {
      data,
      error,
    } = await db
      .from("widgets")
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error(
        "[widgets] create widget error:",
        error
      );

      return res.status(500).json({
        error: error.message,
      });
    }

    res.json(data);
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// تحديث Widget
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.put(
  "/dashboard/:id",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    let tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      const {
        data: newTenant,
        error,
      } = await db
        .from("tenants")
        .insert({
          user_id: userId,
          business_name: "مشروعي",
          source_type: "manual",
          credits_remaining: 1000,
          is_active: true,
          activated_at:
            new Date().toISOString(),
        })
        .select()
        .single();

      if (error || !newTenant) {
        return res.status(500).json({
          error: "تعذر إنشاء حساب",
        });
      }

      tenant = newTenant;
    }

    const {
      settings,
      name,
      enabled,
    } = req.body ?? {};

    const patch: Record<
      string,
      any
    > = {};

    if (name !== undefined) {
      patch.name =
        String(name).trim();
    }

    if (enabled !== undefined) {
      patch.enabled = enabled;
    }

    if (
      settings &&
      typeof settings === "object"
    ) {
      /*
       * مهم جداً:
       *
       * نحفظ settings بالكامل كما أرسلها
       * الـ Editor.
       *
       * هذا يمنع حذف:
       * settings.avatar.botAvatar.url
       * settings.avatar.headerLogo.url
       */
      patch.settings = settings;

      if (
        settings.appearance &&
        settings.chat
      ) {
        if (
          settings.chat.welcomeMessage !==
          undefined
        ) {
          patch.welcome_message =
            settings.chat.welcomeMessage;
        }

        if (
          settings.appearance.primaryColor !==
          undefined
        ) {
          patch.primary_color =
            settings.appearance.primaryColor;
        }

        if (
          settings.appearance.headerColor !==
          undefined
        ) {
          patch.header_color =
            settings.appearance.headerColor;
        }

        if (
          settings.appearance.textColor !==
          undefined
        ) {
          patch.text_color =
            settings.appearance.textColor;
        }

        if (
          settings.appearance.position !==
          undefined
        ) {
          patch.position =
            settings.appearance.position;
        }

        if (
          settings.localization?.language !==
          undefined
        ) {
          patch.language =
            settings.localization.language;
        }

        if (
          settings.localization?.rtl !==
          undefined
        ) {
          patch.rtl =
            settings.localization.rtl;
        }

        if (
          settings.branding?.showBranding !==
          undefined
        ) {
          patch.show_branding =
            settings.branding.showBranding;
        }

        if (
          settings.chat.placeholder !==
          undefined
        ) {
          patch.placeholder =
            settings.chat.placeholder;
        }

        /*
         * الصور
         */
        if (
          settings.avatar?.botAvatar?.url !==
          undefined
        ) {
          patch.avatar_url =
            settings.avatar.botAvatar.url;
        }

        if (
          settings.avatar?.headerLogo?.url !==
          undefined
        ) {
          patch.logo_url =
            settings.avatar.headerLogo.url;
        }

        if (
          settings.avatar?.botTagline !==
          undefined
        ) {
          patch.agent_tagline =
            settings.avatar.botTagline;
        }

        if (
          settings.appearance.borderRadius !==
          undefined
        ) {
          patch.border_radius =
            settings.appearance.borderRadius;
        }

        if (
          settings.appearance.shadow !==
          undefined
        ) {
          patch.shadow =
            settings.appearance.shadow;
        }

        if (
          settings.appearance.width !==
          undefined
        ) {
          patch.window_width =
            settings.appearance.width;
        }

        if (
          settings.appearance.height !==
          undefined
        ) {
          patch.window_height =
            settings.appearance.height;
        }

        if (
          settings.appearance.launcher?.size !==
          undefined
        ) {
          patch.launcher_size =
            settings.appearance.launcher.size;
        }

        if (
          settings.appearance.launcher?.shape !==
          undefined
        ) {
          patch.launcher_shape =
            settings.appearance.launcher.shape;
        }

        if (
          settings.appearance.launcher
            ?.customIcon !==
          undefined
        ) {
          patch.launcher_icon_url =
            settings.appearance.launcher.customIcon;
        }

        if (
          settings.chatWindow?.header
            ?.showStatus !==
          undefined
        ) {
          patch.show_status =
            settings.chatWindow.header.showStatus;
        }

        if (
          settings.chatWindow?.bubbles
            ?.showTimestamp !==
          undefined
        ) {
          patch.show_timestamps =
            settings.chatWindow.bubbles.showTimestamp;
        }

        if (
          settings.chat?.showTypingIndicator !==
          undefined
        ) {
          patch.typing_indicator =
            settings.chat.showTypingIndicator;
        }
      } else {
        /*
         * دعم صيغة الإعدادات القديمة.
         */

        if (
          settings.welcomeMessage !==
          undefined
        ) {
          patch.welcome_message =
            settings.welcomeMessage;
        }

        if (
          settings.primaryColor !==
          undefined
        ) {
          patch.primary_color =
            settings.primaryColor;
        }

        if (
          settings.headerColor !==
          undefined
        ) {
          patch.header_color =
            settings.headerColor;
        }

        if (
          settings.textColor !==
          undefined
        ) {
          patch.text_color =
            settings.textColor;
        }

        if (
          settings.position !==
          undefined
        ) {
          patch.position =
            settings.position;
        }

        if (
          settings.language !==
          undefined
        ) {
          patch.language =
            settings.language;
        }

        if (
          settings.rtl !==
          undefined
        ) {
          patch.rtl =
            settings.rtl;
        }

        if (
          settings.avatarUrl !==
          undefined
        ) {
          patch.avatar_url =
            settings.avatarUrl;
        }

        if (
          settings.logoUrl !==
          undefined
        ) {
          patch.logo_url =
            settings.logoUrl;
        }

        /*
         * لا نستخدم agent_name.
         */

        if (
          settings.agentTagline !==
          undefined
        ) {
          patch.agent_tagline =
            settings.agentTagline;
        }

        if (
          settings.showBranding !==
          undefined
        ) {
          patch.show_branding =
            settings.showBranding;
        }

        if (
          settings.placeholder !==
          undefined
        ) {
          patch.placeholder =
            settings.placeholder;
        }

        if (
          settings.suggestedQuestions !==
          undefined
        ) {
          patch.suggested_questions =
            settings.suggestedQuestions;
        }

        if (
          settings.borderRadius !==
          undefined
        ) {
          patch.border_radius =
            settings.borderRadius;
        }

        if (
          settings.shadow !==
          undefined
        ) {
          patch.shadow =
            settings.shadow;
        }

        if (
          settings.windowWidth !==
          undefined
        ) {
          patch.window_width =
            settings.windowWidth;
        }

        if (
          settings.windowHeight !==
          undefined
        ) {
          patch.window_height =
            settings.windowHeight;
        }

        if (
          settings.launcherSize !==
          undefined
        ) {
          patch.launcher_size =
            settings.launcherSize;
        }

        if (
          settings.launcherShape !==
          undefined
        ) {
          patch.launcher_shape =
            settings.launcherShape;
        }

        if (
          settings.launcherIconUrl !==
          undefined
        ) {
          patch.launcher_icon_url =
            settings.launcherIconUrl;
        }

        if (
          settings.showStatus !==
          undefined
        ) {
          patch.show_status =
            settings.showStatus;
        }

        if (
          settings.showTimestamps !==
          undefined
        ) {
          patch.show_timestamps =
            settings.showTimestamps;
        }

        if (
          settings.typingIndicator !==
          undefined
        ) {
          patch.typing_indicator =
            settings.typingIndicator;
        }
      }
    }

    /*
     * إذا لم يوجد أي شيء للتحديث
     */
    if (
      Object.keys(patch).length === 0
    ) {
      return res.status(400).json({
        error:
          "لا توجد بيانات لتحديث الـ Widget",
      });
    }

    const {
      data,
      error,
    } = await db
      .from("widgets")
      .update(patch)
      .eq("id", req.params.id)
      .eq("tenant_id", tenant.id)
      .select()
      .single();

    if (error) {
      console.error(
        "[widgets] update widget error:",
        error
      );

      return res.status(500).json({
        error: error.message,
      });
    }

    res.json(data);
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// تحليل الموقع
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/dashboard/ai/analyze-site",
  rateLimit({
    windowMs: 60_000,
    max: 5,
  }),
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        error: "لا يوجد حساب مرتبط",
      });
    }

    const { url } =
      req.body ?? {};

    if (
      !url ||
      typeof url !== "string"
    ) {
      return res.status(400).json({
        error: "الرابط مطلوب",
      });
    }

    const { data: usage } =
      await db.rpc(
        "check_ai_usage",
        {
          p_tenant_id: tenant.id,
          p_limit: 5,
        }
      );

    if (
      usage &&
      usage.length > 0 &&
      usage[0].remaining <= 0
    ) {
      return res.status(429).json({
        error:
          "تم تجاوز الحد اليومي لاستخدام الذكاء الاصطناعي",
        resetAt:
          usage[0].reset_at,
      });
    }

    try {
      const {
        extractFromUrl,
      } = await import(
        "../rag/ingest.js"
      );

      const {
        text,
        title,
      } = await extractFromUrl(url);

      const colors =
        extractColors(text);

      const fontFamily =
        extractFontFamily(text);

      const borderRadius =
        extractBorderRadius(text);

      const theme =
        text.includes("dark") ||
        text.includes("#000")
          ? "dark"
          : "light";

      const logo =
        extractLogo(text);

      const suggestedWelcome =
        await generateWelcomeMessage(
          title,
          text
        );

      await db.rpc(
        "record_ai_usage",
        {
          p_tenant_id: tenant.id,
          p_action: "site_analysis",
        }
      );

      res.json({
        url,
        colors,
        fontFamily,
        borderRadius,
        theme,
        logo,
        suggestedWelcome,
      });
    } catch (e: any) {
      console.error(
        "[widgets] AI analyze error:",
        e
      );

      res.status(500).json({
        error:
          "تعذر تحليل الموقع: " +
          e.message,
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// رفع صور Widget
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * رفع صورة Widget — Avatar / Logo
 *
 * يحفظ الصورة في:
 *
 * 1. Supabase Storage
 * 2. widget_assets
 * 3. widgets.settings
 * 4. widgets.avatar_url / logo_url
 *
 * وبالتالي تصبح الصورة مرتبطة فعلياً
 * بالـ Widget.
 */

widgetsRouter.post(
  "/dashboard/upload",
  rateLimit({
    windowMs: 60_000,
    max: 10,
  }),
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const body =
      req.body ?? {};

    const widgetId =
      body.widget_id ??
      body.widgetId ??
      null;

    const type =
      body.type ??
      null;

    const base64Data =
      body.data ??
      null;

    const originalName =
      body.original_name ??
      body.name ??
      "image";

    const sizeBytes =
      body.size_bytes ??
      body.size ??
      null;

    const mimeType =
      body.mime_type ??
      body.mimeType ??
      "image/png";

    if (!widgetId) {
      return res.status(400).json({
        error:
          "widget_id مطلوب. يجب حفظ الـ Widget أولاً ثم رفع الصورة.",
      });
    }

    if (
      !type ||
      !["avatar", "logo"].includes(
        type
      )
    ) {
      return res.status(400).json({
        error:
          "نوع الصورة غير صالح. الأنواع المدعومة: avatar أو logo",
      });
    }

    if (
      !base64Data ||
      typeof base64Data !==
        "string"
    ) {
      return res.status(400).json({
        error:
          "بيانات الصورة مطلوبة",
      });
    }

    if (
      sizeBytes !== null &&
      Number(sizeBytes) >
        1024 * 1024
    ) {
      return res.status(400).json({
        error:
          "حجم الملف يتجاوز 1MB",
      });
    }

    const tenant =
      await ownedTenant(
        userId,
        body.tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    try {
      /*
       * التحقق من ملكية Widget
       */
      const {
        data: widget,
        error: widgetError,
      } = await db
        .from("widgets")
        .select(
          "id, tenant_id, name, settings"
        )
        .eq("id", widgetId)
        .eq(
          "tenant_id",
          tenant.id
        )
        .maybeSingle();

      if (widgetError) {
        console.error(
          "[widgets] widget ownership lookup error:",
          widgetError
        );

        return res.status(500).json({
          error:
            "تعذر التحقق من الـ Widget: " +
            widgetError.message,
        });
      }

      if (!widget) {
        return res.status(404).json({
          error:
            "الـ Widget غير موجود أو لا ينتمي إلى حسابك",
        });
      }

      /*
       * Supabase Service Role
       */
      const {
        createClient,
      } = await import(
        "@supabase/supabase-js"
      );

      const supabase =
        createClient(
          process.env.SUPABASE_URL!,
          process.env
            .SUPABASE_SERVICE_ROLE_KEY!
        );

      /*
       * تنظيف اسم الملف
       */
      const safeOriginalName =
        String(originalName)
          .replace(
            /[/\\]/g,
            "_"
          )
          .replace(
            /[^a-zA-Z0-9._\-\u0600-\u06FF]/g,
            "_"
          )
          .slice(0, 120) ||
        "image";

      /*
       * إزالة Data URL إذا وصلت
       */
      let cleanBase64 =
        base64Data;

      if (
        cleanBase64.includes(",")
      ) {
        cleanBase64 =
          cleanBase64
            .split(",")
            .pop() ?? "";
      }

      if (!cleanBase64) {
        return res.status(400).json({
          error:
            "بيانات الصورة غير صالحة",
        });
      }

      /*
       * أنواع الصور المسموحة
       */
      const allowedMimeTypes =
        [
          "image/png",
          "image/jpeg",
          "image/jpg",
          "image/webp",
          "image/gif",
        ];

      if (
        !allowedMimeTypes.includes(
          mimeType
        )
      ) {
        return res.status(400).json({
          error:
            "نوع الصورة غير مدعوم. استخدم PNG أو JPG أو WEBP أو GIF.",
        });
      }

      /*
       * Base64 → Buffer
       */
      let fileBuffer: Buffer;

      try {
        fileBuffer =
          Buffer.from(
            cleanBase64,
            "base64"
          );
      } catch {
        return res.status(400).json({
          error:
            "تعذر قراءة بيانات الصورة",
        });
      }

      if (!fileBuffer.length) {
        return res.status(400).json({
          error:
            "الصورة فارغة أو بياناتها غير صالحة",
        });
      }

      /*
       * حماية إضافية من الملفات الكبيرة
       */
      if (
        fileBuffer.length >
        1024 * 1024
      ) {
        return res.status(400).json({
          error:
            "حجم الملف يتجاوز 1MB",
        });
      }

      /*
       * الامتداد
       */
      const extensionMap: Record<
        string,
        string
      > = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
      };

      const extension =
        extensionMap[mimeType] ??
        "png";

      /*
       * مسار الملف:
       *
       * tenant_id/
       * widget_id/
       * type/
       * filename
       */
      const fileName =
        `${tenant.id}/${widget.id}/${type}/` +
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}.${extension}`;

      /*
       * رفع إلى Storage
       */
      const {
        error: uploadError,
      } =
        await supabase.storage
          .from("widget-assets")
          .upload(
            fileName,
            fileBuffer,
            {
              contentType:
                mimeType,
              upsert: false,
            }
          );

      if (uploadError) {
        console.error(
          "[widgets] storage upload error:",
          uploadError
        );

        return res.status(500).json({
          error:
            "تعذر رفع الصورة إلى التخزين: " +
            uploadError.message,
        });
      }

      /*
       * Public URL
       */
      const {
        data: urlData,
      } =
        supabase.storage
          .from("widget-assets")
          .getPublicUrl(
            fileName
          );

      const publicUrl =
        urlData?.publicUrl;

      if (!publicUrl) {
        await supabase.storage
          .from("widget-assets")
          .remove([
            fileName,
          ])
          .catch(() => {});

        return res.status(500).json({
          error:
            "تم رفع الصورة لكن تعذر إنشاء رابطها",
        });
      }

      /*
       * حفظ سجل الصورة
       */
      const {
        data: asset,
        error: assetError,
      } = await db
        .from("widget_assets")
        .insert({
          tenant_id: tenant.id,
          widget_id: widget.id,
          type,
          url: publicUrl,
          original_name:
            safeOriginalName,
          size_bytes:
            fileBuffer.length,
          mime_type:
            mimeType,
        })
        .select()
        .single();

      if (assetError) {
        console.error(
          "[widgets] widget_assets insert error:",
          assetError
        );

        await supabase.storage
          .from("widget-assets")
          .remove([
            fileName,
          ])
          .catch(() => {});

        return res.status(500).json({
          error:
            "تم رفع الصورة لكن تعذر حفظ سجلها: " +
            assetError.message,
        });
      }

      // ═══════════════════════════════════════════════════════════════════════
      // تحديث إعدادات الـ Widget مباشرة
      // ═══════════════════════════════════════════════════════════════════════

      const currentSettings =
        widget.settings &&
        typeof widget.settings ===
          "object"
          ? widget.settings
          : {};

      const currentAvatar =
        currentSettings.avatar &&
        typeof currentSettings.avatar ===
          "object"
          ? currentSettings.avatar
          : {};

      const currentBotAvatar =
        currentAvatar.botAvatar &&
        typeof currentAvatar.botAvatar ===
          "object"
          ? currentAvatar.botAvatar
          : {};

      const currentHeaderLogo =
        currentAvatar.headerLogo &&
        typeof currentAvatar.headerLogo ===
          "object"
          ? currentAvatar.headerLogo
          : {};

      const updatedSettings = {
        ...currentSettings,

        avatar: {
          ...currentAvatar,

          botAvatar: {
            ...currentBotAvatar,
          },

          headerLogo: {
            ...currentHeaderLogo,
          },
        },
      };

      /*
       * Avatar
       */
      if (type === "avatar") {
        updatedSettings.avatar.botAvatar =
          {
            ...updatedSettings.avatar
              .botAvatar,

            url: publicUrl,
          };
      }

      /*
       * Logo
       */
      if (type === "logo") {
        updatedSettings.avatar.headerLogo =
          {
            ...updatedSettings.avatar
              .headerLogo,

            url: publicUrl,
          };
      }

      /*
       * أعمدة التوافق القديمة
       */
      const widgetPatch: Record<
        string,
        any
      > = {
        settings:
          updatedSettings,
      };

      if (type === "avatar") {
        widgetPatch.avatar_url =
          publicUrl;
      }

      if (type === "logo") {
        widgetPatch.logo_url =
          publicUrl;
      }

      /*
       * حفظ الرابط داخل widgets
       */
      const {
        error: widgetUpdateError,
      } = await db
        .from("widgets")
        .update(widgetPatch)
        .eq("id", widget.id)
        .eq(
          "tenant_id",
          tenant.id
        );

      if (widgetUpdateError) {
        console.error(
          "[widgets] widget settings update error:",
          widgetUpdateError
        );

        return res.status(500).json({
          error:
            "تم رفع الصورة لكن تعذر ربطها بالـ Widget: " +
            widgetUpdateError.message,
        });
      }

      /*
       * إرجاع النتيجة للواجهة
       */
      return res.json({
        success: true,

        id: asset.id,
        assetId: asset.id,

        url: publicUrl,

        widgetId: widget.id,
        widget_id: widget.id,

        type,

        originalName:
          safeOriginalName,

        sizeBytes:
          fileBuffer.length,

        mimeType,

        persisted: true,
      });
    } catch (e: any) {
      console.error(
        "[widgets] upload error:",
        e
      );

      return res.status(500).json({
        error:
          "تعذر رفع الصورة: " +
          (e?.message ||
            "خطأ غير معروف"),
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// عداد الردود
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.get(
  "/dashboard/:id/quota",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.query.tenantId as string
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    const {
      data: widget,
    } = await db
      .from("widgets")
      .select(
        "id, name, replies_used, replies_limit"
      )
      .eq(
        "id",
        req.params.id
      )
      .eq(
        "tenant_id",
        tenant.id
      )
      .maybeSingle();

    if (!widget) {
      return res.status(404).json({
        error:
          "Widget غير موجود",
      });
    }

    const {
      data: tenantData,
    } = await db
      .from("tenants")
      .select(
        "credits_remaining"
      )
      .eq(
        "id",
        tenant.id
      )
      .single();

    res.json({
      widgetId: widget.id,
      widgetName: widget.name,
      repliesUsed:
        widget.replies_used ||
        0,
      repliesLimit:
        widget.replies_limit,
      tenantCredits:
        tenantData?.credits_remaining ||
        0,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// حذف Widget
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.delete(
  "/dashboard/:id",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    let tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      const {
        data: newTenant,
        error,
      } = await db
        .from("tenants")
        .insert({
          user_id: userId,
          business_name: "مشروعي",
          source_type: "manual",
          credits_remaining: 1000,
          is_active: true,
          activated_at:
            new Date().toISOString(),
        })
        .select()
        .single();

      if (error || !newTenant) {
        return res.status(500).json({
          error:
            "تعذر إنشاء حساب",
        });
      }

      tenant = newTenant;
    }

    const { error } =
      await db
        .from("widgets")
        .delete()
        .eq(
          "id",
          req.params.id
        )
        .eq(
          "tenant_id",
          tenant.id
        );

    if (error) {
      return res.status(500).json({
        error: error.message,
      });
    }

    res.json({
      ok: true,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// Public Widget
// ═══════════════════════════════════════════════════════════════════════════════

/** جلب إعدادات widget */
widgetsRouter.get(
  "/public/:token",
  async (req, res) => {
    const {
      data: widget,
      error,
    } = await db
      .from("widgets")
      .select("*")
      .eq(
        "public_token",
        req.params.token
      )
      .maybeSingle();

    if (error || !widget) {
      return res.status(404).json({
        error:
          "Widget غير موجود",
      });
    }

    if (!widget.enabled) {
      return res.status(403).json({
        error:
          "Widget معطّل",
      });
    }

    const {
      data: tenant,
    } = await db
      .from("tenants")
      .select(
        "business_name"
      )
      .eq(
        "id",
        widget.tenant_id
      )
      .single();

    const settings =
      widget.settings || {};

    const appearance =
      settings.appearance ||
      {};

    const avatar =
      settings.avatar ||
      {};

    const chatWindow =
      settings.chatWindow ||
      {};

    const chat =
      settings.chat ||
      {};

    res.json({
      widgetId: widget.id,

      name: widget.name,

      businessName:
        tenant?.business_name ??
        "ميلانو",

      welcomeMessage:
        widget.welcome_message ||
        chat.welcomeMessage ||
        "مرحباً! كيف يمكنني مساعدتك؟",

      primaryColor:
        widget.primary_color ||
        appearance.primaryColor ||
        "#2ec27e",

      headerColor:
        widget.header_color ||
        chatWindow.header
          ?.backgroundColor ||
        widget.primary_color ||
        "#2ec27e",

      textColor:
        widget.text_color ||
        chatWindow.header
          ?.textColor ||
        "#ffffff",

      position:
        widget.position ||
        appearance.position ||
        "left",

      language:
        widget.language ||
        settings.localization
          ?.language ||
        "ar",

      rtl:
        widget.rtl !== undefined
          ? widget.rtl
          : settings.localization
              ?.rtl ?? true,

      avatarUrl:
        widget.avatar_url ||
        avatar.botAvatar?.url ||
        null,

      logoUrl:
        widget.logo_url ||
        avatar.headerLogo?.url ||
        null,

      /*
       * اسم المساعد أصبح من settings
       * بدلاً من agent_name.
       */
      agentName:
        avatar.botName ||
        avatar.botAvatar?.agentName ||
        widget.name,

      agentTagline:
        widget.agent_tagline ||
        avatar.botTagline ||
        avatar.botAvatar?.agentTitle ||
        tenant?.business_name ||
        "مساعد ذكي",

      showStatus:
        widget.show_status !==
        undefined
          ? widget.show_status
          : chatWindow.header
                ?.showStatus !==
            false,

      showBranding:
        widget.show_branding !==
        undefined
          ? widget.show_branding
          : settings.branding
              ?.showBranding ??
            true,

      placeholder:
        widget.placeholder ||
        chat.placeholder ||
        "اكتب رسالتك...",

      suggestedQuestions:
        widget.suggested_questions ||
        [],

      borderRadius:
        widget.border_radius ??
        appearance.borderRadius ??
        chatWindow.borderRadius ??
        16,

      shadow:
        widget.shadow ??
        appearance.shadow ??
        chatWindow.shadow ??
        "medium",

      windowWidth:
        widget.window_width ??
        appearance.width ??
        chatWindow.width ??
        380,

      windowHeight:
        widget.window_height ??
        appearance.height ??
        chatWindow.height ??
        560,

      headerBackgroundColor:
        widget.header_color ||
        chatWindow.header
          ?.backgroundColor ||
        widget.primary_color ||
        "#2ec27e",

      headerTextColor:
        widget.text_color ||
        chatWindow.header
          ?.textColor ||
        "#ffffff",

      launcherSize:
        widget.launcher_size ??
        appearance.launcher?.size ??
        chatWindow.launcher?.size ??
        60,

      launcherShape:
        widget.launcher_shape ??
        appearance.launcher?.shape ??
        chatWindow.launcher?.shape ??
        "circle",

      launcherIconUrl:
        widget.launcher_icon_url ||
        appearance.launcher
          ?.customIcon ||
        null,

      launcherOffsetY:
        appearance.offset?.y ??
        20,

      showTimestamp:
        widget.show_timestamps !==
        undefined
          ? widget.show_timestamps
          : chatWindow.bubbles
                ?.showTimestamp !==
            false,

      typingIndicator:
        widget.typing_indicator !==
        undefined
          ? widget.typing_indicator
          : true,
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// إنشاء / استرجاع Session
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/public/:token/session",
  rateLimit({
    windowMs: 60_000,
    max: 20,
  }),
  async (req, res) => {
    const {
      data: widget,
    } = await db
      .from("widgets")
      .select(
        "id, tenant_id, enabled"
      )
      .eq(
        "public_token",
        req.params.token
      )
      .maybeSingle();

    if (
      !widget ||
      !widget.enabled
    ) {
      return res.status(404).json({
        error:
          "Widget غير موجود أو معطّل",
      });
    }

    const {
      visitorId,
    } = req.body ?? {};

    if (!visitorId) {
      return res.status(400).json({
        error:
          "visitorId مطلوب",
      });
    }

    const {
      data: existing,
    } = await db
      .from("widget_sessions")
      .select("*")
      .eq(
        "widget_id",
        widget.id
      )
      .eq(
        "visitor_id",
        visitorId
      )
      .maybeSingle();

    if (existing) {
      const {
        data: messages,
      } = await db
        .from("widget_messages")
        .select(
          "id, direction, body, kind, created_at"
        )
        .eq(
          "session_id",
          existing.id
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        )
        .limit(50);

      return res.json({
        sessionId:
          existing.id,
        messages:
          messages ?? [],
      });
    }

    const {
      data: session,
      error,
    } = await db
      .from("widget_sessions")
      .insert({
        widget_id:
          widget.id,
        tenant_id:
          widget.tenant_id,
        visitor_id:
          visitorId,
        visitor_ip:
          req.ip ?? null,
        visitor_ua: (
          req.headers[
            "user-agent"
          ] ?? ""
        ).slice(0, 200),
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }

    const {
      data: welcomeWidget,
    } = await db
      .from("widgets")
      .select(
        "welcome_message"
      )
      .eq(
        "id",
        widget.id
      )
      .single();

    if (
      welcomeWidget?.welcome_message
    ) {
      await db
        .from("widget_messages")
        .insert({
          session_id:
            session.id,
          widget_id:
            widget.id,
          tenant_id:
            widget.tenant_id,
          direction: "out",
          body:
            welcomeWidget
              .welcome_message,
          kind: "answer",
        });
    }

    res.json({
      sessionId:
        session.id,

      messages:
        welcomeWidget?.welcome_message
          ? [
              {
                id: "welcome",
                direction: "out",
                body:
                  welcomeWidget
                    .welcome_message,
                kind: "answer",
                created_at:
                  new Date().toISOString(),
              },
            ]
          : [],
    });
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// استخراج التعلم من المحادثات
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/dashboard/extract-learning",
  rateLimit({
    windowMs: 60_000,
    max: 10,
  }),
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    const {
      sessionId,
    } = req.body ?? {};

    if (!sessionId) {
      return res.status(400).json({
        error:
          "sessionId مطلوب",
      });
    }

    try {
      const {
        data: messages,
        error,
      } = await db
        .from("widget_messages")
        .select("*")
        .eq(
          "session_id",
          sessionId
        )
        .order(
          "created_at",
          {
            ascending: true,
          }
        );

      if (
        error ||
        !messages ||
        messages.length === 0
      ) {
        return res.status(404).json({
          error:
            "لا توجد رسائل في هذه الجلسة",
        });
      }

      const conversationText =
        messages
          .map(
            (m) =>
              `${
                m.direction ===
                "in"
                  ? "العميل"
                  : "المساعد"
              }: ${m.body}`
          )
          .join("\n");

      const prompt = `حلل المحادثة التالية واستخرج المعلومات المفيدة التي يمكن إضافتها إلى قاعدة المعرفة.
استخرج فقط المعلومات الواقعية والمفيدة التي قد يسأل عنها عملاء آخرون.
لا تستخرج معلومات شخصية أو خاصة بالعميل.
أعد النتيجة كمصفوفة JSON بهذا الشكل: [{"question": "السؤال المتوقع", "answer": "الإجابة المستخرجة"}]

المحادثة:
${conversationText}`;

      const response =
        await chatCompletion(
          "أنت مساعد في استخراج المعلومات المفيدة من المحادثات.",
          prompt,
          {
            json: true,
          }
        );

      const cleaned =
        response
          .replace(
            /```(?:json)?/g,
            ""
          )
          .trim();

      const match =
        cleaned.match(
          /\[[\s\S]*\]/
        );

      if (!match) {
        return res.json({
          learnings: [],
        });
      }

      let learnings: any[];

      try {
        learnings =
          JSON.parse(match[0]);
      } catch {
        return res.json({
          learnings: [],
        });
      }

      const candidates =
        learnings
          .filter(
            (l) =>
              l.question &&
              l.answer
          )
          .map((l) => ({
            tenant_id:
              tenant.id,
            session_id:
              sessionId,
            question:
              l.question.trim(),
            answer:
              l.answer.trim(),
            status: "pending",
          }));

      if (
        candidates.length > 0
      ) {
        const {
          error: insertError,
        } = await db
          .from(
            "learning_candidates"
          )
          .insert(
            candidates
          );

        if (insertError) {
          console.error(
            "[widgets] insert learning candidates error:",
            insertError
          );
        }
      }

      res.json({
        learnings:
          candidates,
        count:
          candidates.length,
      });
    } catch (err: any) {
      console.error(
        "[widgets] extract learning error:",
        err
      );

      res.status(500).json({
        error:
          "تعذر استخراج المعلومات: " +
          err.message,
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// الموافقة على التعلم
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/dashboard/approve-learning/:id",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    const { id } =
      req.params;

    try {
      const {
        data: candidate,
        error,
      } = await db
        .from(
          "learning_candidates"
        )
        .select("*")
        .eq("id", id)
        .eq(
          "tenant_id",
          tenant.id
        )
        .single();

      if (
        error ||
        !candidate
      ) {
        return res.status(404).json({
          error:
            "المعلومات المرشحة غير موجودة",
        });
      }

      const text =
        `س: ${candidate.question}\n` +
        `ج: ${candidate.answer}`;

      const [vector] =
        await embed([text]);

      const {
        error: insertError,
      } = await db
        .from(
          "knowledge_chunks"
        )
        .insert({
          tenant_id:
            tenant.id,
          content: text,
          embedding:
            toPgVector(vector),
        });

      if (insertError) {
        return res.status(500).json({
          error:
            "تعذر إضافة المعلومات إلى قاعدة المعرفة: " +
            insertError.message,
        });
      }

      await db
        .from(
          "learning_candidates"
        )
        .update({
          status: "approved",
          approved_at:
            new Date().toISOString(),
        })
        .eq("id", id);

      res.json({
        success: true,
        message:
          "تمت الموافقة على المعلومات وإضافتها إلى قاعدة المعرفة",
      });
    } catch (err: any) {
      console.error(
        "[widgets] approve learning error:",
        err
      );

      res.status(500).json({
        error:
          "تعذر الموافقة على المعلومات: " +
          err.message,
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// رفض التعلم
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/dashboard/reject-learning/:id",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.body?.tenantId
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    const { id } =
      req.params;

    try {
      await db
        .from(
          "learning_candidates"
        )
        .update({
          status: "rejected",
          rejected_at:
            new Date().toISOString(),
        })
        .eq("id", id)
        .eq(
          "tenant_id",
          tenant.id
        );

      res.json({
        success: true,
        message:
          "تم رفض المعلومات",
      });
    } catch (err: any) {
      console.error(
        "[widgets] reject learning error:",
        err
      );

      res.status(500).json({
        error:
          "تعذر رفض المعلومات: " +
          err.message,
      });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// جلب التعلم المرشح
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.get(
  "/dashboard/learning-candidates",
  async (req, res) => {
    const userId =
      (req as AuthedRequest).userId!;

    const tenant =
      await ownedTenant(
        userId,
        req.query.tenantId as string
      );

    if (!tenant) {
      return res.status(404).json({
        error:
          "لا يوجد حساب مرتبط",
      });
    }

    const {
      data,
      error,
    } = await db
      .from(
        "learning_candidates"
      )
      .select("*")
      .eq(
        "tenant_id",
        tenant.id
      )
      .eq(
        "status",
        "pending"
      )
      .order(
        "created_at",
        {
          ascending: false,
        }
      );

    if (error) {
      return res.status(500).json({
        error:
          error.message,
      });
    }

    res.json(data ?? []);
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// إرسال رسالة والحصول على رد
// ═══════════════════════════════════════════════════════════════════════════════

widgetsRouter.post(
  "/public/:token/message",
  rateLimit({
    windowMs: 60_000,
    max: 30,
  }),
  async (req, res) => {
    const {
      data: widget,
    } = await db
      .from("widgets")
      .select(
        "id, tenant_id, enabled"
      )
      .eq(
        "public_token",
        req.params.token
      )
      .maybeSingle();

    if (
      !widget ||
      !widget.enabled
    ) {
      return res.status(404).json({
        error:
          "Widget غير موجود أو معطّل",
      });
    }

    const {
      sessionId,
      message,
    } = req.body ?? {};

    if (
      !sessionId ||
      !message?.trim()
    ) {
      return res.status(400).json({
        error:
          "sessionId و message مطلوبان",
      });
    }

    const {
      data: session,
    } = await db
      .from(
        "widget_sessions"
      )
      .select("*")
      .eq(
        "id",
        sessionId
      )
      .eq(
        "widget_id",
        widget.id
      )
      .maybeSingle();

    if (!session) {
      return res.status(404).json({
        error:
          "جلسة غير موجودة",
      });
    }

    await db
      .from(
        "widget_messages"
      )
      .insert({
        session_id:
          session.id,
        widget_id:
          widget.id,
        tenant_id:
          widget.tenant_id,
        direction: "in",
        body:
          message.trim(),
        kind: "customer",
      });

    await db
      .from(
        "widget_sessions"
      )
      .update({
        last_message_at:
          new Date().toISOString(),
      })
      .eq(
        "id",
        session.id
      );

    const {
      data: tenant,
    } = await db
      .from("tenants")
      .select(
        "credits_remaining, business_name"
      )
      .eq(
        "id",
        widget.tenant_id
      )
      .single();

    const {
      data: widgetData,
    } = await db
      .from("widgets")
      .select(
        "replies_used, replies_limit, settings"
      )
      .eq(
        "id",
        widget.id
      )
      .single();

    if (
      !tenant ||
      tenant.credits_remaining <=
        0
    ) {
      const quotaMessage =
        widgetData?.settings
          ?.chat
          ?.quotaExceededMessage ||
        "الخدمة غير متاحة مؤقتاً، اترك بريدك وسنتواصل معك";

      await db
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,
          widget_id:
            widget.id,
          tenant_id:
            widget.tenant_id,
          direction: "out",
          body:
            quotaMessage,
          kind:
            "quota_exceeded",
        });

      return res.status(429).json({
        reply:
          quotaMessage,
        kind:
          "quota_exceeded",
        quotaExceeded: true,
      });
    }

    if (
      widgetData?.replies_limit &&
      widgetData.replies_used >=
        widgetData.replies_limit
    ) {
      const quotaMessage =
        widgetData?.settings
          ?.chat
          ?.quotaExceededMessage ||
        "تم تجاوز الحد المسموح لهذا المساعد.";

      await db
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,
          widget_id:
            widget.id,
          tenant_id:
            widget.tenant_id,
          direction: "out",
          body:
            quotaMessage,
          kind:
            "quota_exceeded",
        });

      return res.status(429).json({
        reply:
          quotaMessage,
        kind:
          "quota_exceeded",
        quotaExceeded: true,
      });
    }

    try {
      const result =
        await answerFromKnowledge(
          widget.tenant_id,
          tenant.business_name,
          message.trim()
        );

      let replyText: string;
      let kind: string;

      if (
        result.confident &&
        result.answer
      ) {
        replyText =
          result.answer;

        kind = "answer";
      } else {
        replyText =
          "عذرًا، ما عندي معلومات مؤكدة عن هذا الموضوع. هل تقدر توضح أكثر؟";

        kind = "refusal";

        await db
          .from(
            "unresolved_questions"
          )
          .insert({
            tenant_id:
              widget.tenant_id,
            question_encrypted:
              message.trim(),
            best_similarity:
              result.bestSimilarity,
          });
      }

      await db
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,
          widget_id:
            widget.id,
          tenant_id:
            widget.tenant_id,
          direction: "out",
          body:
            replyText,
          kind,
        });

      const {
        data: lastMsg,
      } = await db
        .from(
          "widget_messages"
        )
        .select("id")
        .eq(
          "session_id",
          session.id
        )
        .order(
          "created_at",
          {
            ascending: false,
          }
        )
        .limit(1);

      await db.rpc(
        "consume_reply",
        {
          p_tenant_id:
            widget.tenant_id,
          p_message_id:
            lastMsg?.[0]?.id,
          p_widget_id:
            widget.id,
        }
      );

      res.json({
        reply:
          replyText,
        kind,
      });
    } catch (err: any) {
      console.error(
        "[widget] reply error:",
        err
      );

      const replyText =
        "عذرًا، حدث خطأ. يرجى المحاولة مرة أخرى.";

      await db
        .from(
          "widget_messages"
        )
        .insert({
          session_id:
            session.id,
          widget_id:
            widget.id,
          tenant_id:
            widget.tenant_id,
          direction: "out",
          body:
            replyText,
          kind: "error",
        });

      res.json({
        reply:
          replyText,
        kind: "error",
      });
    }
  }
);
