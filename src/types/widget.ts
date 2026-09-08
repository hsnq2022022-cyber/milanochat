// ═══════════════════════════════════════════════════════════════════════════════
// أنواع Widgets المتقدمة - Milano
// ═══════════════════════════════════════════════════════════════════════════════

export type WidgetPosition = "left" | "right";
export type WidgetTheme = "light" | "dark";
export type WidgetDevice = "desktop" | "mobile";
export type WidgetState = "open" | "closed";

export type FontFamily = "Cairo" | "Tajawal" | "IBM Plex Arabic" | "system";
export type FontWeight = "400" | "500" | "600" | "700" | "800";

export type LauncherIcon = "chat" | "message" | "support" | "help" | "custom";
export type LauncherShape = "circle" | "square" | "rounded";

export type ShadowLevel = "none" | "light" | "medium" | "strong";

export type AutoOpenTrigger = "disabled" | "delay" | "exit_intent" | "scroll";

export interface WorkingHours {
  enabled: boolean;
  timezone: string;
  schedule: {
    [key: string]: { open: string; close: string; enabled: boolean } | null;
  };
}

export interface PreChatField {
  id: string;
  type: "name" | "email" | "phone" | "dropdown" | "textarea";
  label: string;
  placeholder?: string;
  required: boolean;
  options?: string[]; // للدروب داون
  order: number;
}

export interface QuickReply {
  id: string;
  text: string;
  order: number;
}

export interface VisibilityRule {
  id: string;
  type: "allow" | "block";
  pattern: string; // URL pattern
}

export interface WidgetAppearance {
  // الألوان
  primaryColor: string;
  secondaryColor: string;
  backgroundColor: string;
  textColor: string;
  headerGradient: {
    enabled: boolean;
    from: string;
    to: string;
    angle: number;
  };
  
  // الخطوط
  fontFamily: FontFamily;
  fontSize: number;
  headingWeight: FontWeight;
  
  // الشكل
  borderRadius: number;
  shadow: ShadowLevel;
  blur: number;
  width: number;
  height: number;
  
  // Launcher
  launcher: {
    icon: LauncherIcon;
    customIcon?: string; // URL
    size: number;
    shape: LauncherShape;
    text?: string;
    badge: {
      enabled: boolean;
      count: number;
    };
  };
  
  // الموقع
  position: WidgetPosition;
  offset: {
    x: number;
    y: number;
    mobileX?: number;
    mobileY?: number;
  };
  
  // Avatar
  avatar: {
    url: string | null;
    agentName: string;
    agentTitle?: string;
    statusIndicator: boolean;
  };
}

export interface WidgetChat {
  // الرسائل
  welcomeMessage: string;
  offlineMessage: string;
  unavailableMessage: string;
  placeholder: string;
  
  // Quick Replies
  quickReplies: QuickReply[];
  
  // السلوك
  showTypingIndicator: boolean;
  showReadReceipts: boolean;
  allowFileUpload: boolean;
  fileUpload: {
    enabled: boolean;
    maxFileSize: number; // MB
    allowedTypes: string[];
  };
  
  // أوقات العمل
  workingHours: WorkingHours;
}

export interface WidgetBehavior {
  // الفتح التلقائي
  autoOpen: {
    trigger: AutoOpenTrigger;
    delay?: number; // ثواني
    scrollPercentage?: number;
  };
  
  // الصوت
  sound: {
    enabled: boolean;
    url?: string;
  };
  
  // قواعد الظهور
  visibility: {
    rules: VisibilityRule[];
    hideOnMobile: boolean;
  };
}

export interface WidgetForms {
  // Pre-chat
  preChat: {
    enabled: boolean;
    fields: PreChatField[];
  };
  
  // Offline form
  offlineForm: {
    enabled: boolean;
    fields: PreChatField[];
  };
}

export interface WidgetLocalization {
  language: "ar" | "en";
  rtl: boolean;
  translations: {
    ar?: Record<string, string>;
    en?: Record<string, string>;
  };
}

export interface WidgetBranding {
  showBranding: boolean;
  customFooter?: string;
}

export interface WidgetSettings {
  appearance: WidgetAppearance;
  chat: WidgetChat;
  behavior: WidgetBehavior;
  forms: WidgetForms;
  localization: WidgetLocalization;
  branding: WidgetBranding;
}

export interface Widget {
  id: string;
  tenant_id: string;
  name: string;
  public_token: string;
  enabled: boolean;
  settings: WidgetSettings;
  created_at: string;
  updated_at: string;
}

// القيم الافتراضية
export const DEFAULT_SETTINGS: WidgetSettings = {
  appearance: {
    primaryColor: "#2ec27e",
    secondaryColor: "#e8b24b",
    backgroundColor: "#ffffff",
    textColor: "#1a1a1a",
    headerGradient: {
      enabled: false,
      from: "#2ec27e",
      to: "#178a57",
      angle: 135,
    },
    fontFamily: "Cairo",
    fontSize: 14,
    headingWeight: "600",
    borderRadius: 12,
    shadow: "medium",
    blur: 0,
    width: 380,
    height: 560,
    launcher: {
      icon: "chat",
      size: 60,
      shape: "circle",
      badge: {
        enabled: false,
        count: 0,
      },
    },
    position: "left",
    offset: {
      x: 20,
      y: 20,
    },
    avatar: {
      url: null,
      agentName: "ميلانو",
      agentTitle: "مساعد ذكي",
      statusIndicator: true,
    },
  },
  chat: {
    welcomeMessage: "مرحباً! كيف يمكنني مساعدتك اليوم؟",
    offlineMessage: "نحن غير متصلين حالياً. سنرد على رسالتك في أقرب وقت.",
    unavailableMessage: "عذراً، لا يوجد وكلاء متاحين حالياً.",
    placeholder: "اكتب رسالتك...",
    quickReplies: [],
    showTypingIndicator: true,
    showReadReceipts: true,
    allowFileUpload: false,
    fileUpload: {
      enabled: false,
      maxFileSize: 5,
      allowedTypes: ["image/*", "application/pdf"],
    },
    workingHours: {
      enabled: false,
      timezone: "Asia/Riyadh",
      schedule: {
        sunday: null,
        monday: { open: "09:00", close: "17:00", enabled: true },
        tuesday: { open: "09:00", close: "17:00", enabled: true },
        wednesday: { open: "09:00", close: "17:00", enabled: true },
        thursday: { open: "09:00", close: "17:00", enabled: true },
        friday: { open: "09:00", close: "17:00", enabled: true },
        saturday: null,
      },
    },
  },
  behavior: {
    autoOpen: {
      trigger: "disabled",
    },
    sound: {
      enabled: false,
    },
    visibility: {
      rules: [],
      hideOnMobile: false,
    },
  },
  forms: {
    preChat: {
      enabled: false,
      fields: [],
    },
    offlineForm: {
      enabled: false,
      fields: [],
    },
  },
  localization: {
    language: "ar",
    rtl: true,
    translations: {},
  },
  branding: {
    showBranding: true,
  },
};

// قوالب جاهزة
export const APPEARANCE_PRESETS = {
  minimal: {
    primaryColor: "#2ec27e",
    backgroundColor: "#ffffff",
    textColor: "#1a1a1a",
    borderRadius: 8,
    shadow: "light" as ShadowLevel,
    fontFamily: "system" as FontFamily,
  },
  modern: {
    primaryColor: "#2ec27e",
    backgroundColor: "#f8f9fa",
    textColor: "#212529",
    borderRadius: 16,
    shadow: "medium" as ShadowLevel,
    fontFamily: "Cairo" as FontFamily,
  },
  glass: {
    primaryColor: "#2ec27e",
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    textColor: "#1a1a1a",
    borderRadius: 20,
    shadow: "strong" as ShadowLevel,
    blur: 10,
    fontFamily: "Tajawal" as FontFamily,
  },
  darkPro: {
    primaryColor: "#2ec27e",
    backgroundColor: "#1a1a1a",
    textColor: "#ffffff",
    borderRadius: 12,
    shadow: "strong" as ShadowLevel,
    fontFamily: "IBM Plex Arabic" as FontFamily,
  },
  rounded: {
    primaryColor: "#2ec27e",
    backgroundColor: "#ffffff",
    textColor: "#1a1a1a",
    borderRadius: 24,
    shadow: "medium" as ShadowLevel,
    fontFamily: "Cairo" as FontFamily,
  },
};
