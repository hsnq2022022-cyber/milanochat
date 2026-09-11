/**
 * إعدادات Human Agent Demo Mode
 * 
 * للتفعيل: أضف VITE_HUMAN_AGENT_DEMO_ENABLED=true في .env
 * للتعطيل: احذف المتغير أو اضبطه على false
 */

export const DEMO_CONFIG = {
  // تفعيل/تعطيل Demo Mode
  enabled: (import.meta as any).env?.VITE_HUMAN_AGENT_DEMO_ENABLED === 'true',
  
  // بيانات المحادثة التجريبية
  customer: {
    name: 'أحمد محمد',
    avatar: null, // يمكن إضافة URL لاحقاً
  },
  
  aiAgent: {
    name: 'مساعد ميلانو',
    avatar: null,
  },
  
  humanAgent: {
    name: 'سارة (موظف خدمة العملاء)',
    avatar: null,
  },
  
  // سيناريو المحادثة الافتراضي
  defaultConversation: [
    {
      id: '1',
      sender: 'customer',
      message: 'السلام عليكم، أريد معرفة تفاصيل المنتج.',
      timestamp: new Date(Date.now() - 300000).toISOString(), // قبل 5 دقائق
    },
    {
      id: '2',
      sender: 'ai',
      message: 'وعليكم السلام، أهلاً بك أحمد. بالتأكيد، سأساعدك في معرفة التفاصيل. ما هو المنتج الذي تهتم بمعرفته؟',
      timestamp: new Date(Date.now() - 240000).toISOString(),
    },
    {
      id: '3',
      sender: 'customer',
      message: 'أريد التحدث مع موظف.',
      timestamp: new Date(Date.now() - 180000).toISOString(),
    },
  ],
  
  // رسالة التحويل
  transferMessage: 'جاري تحويلك إلى موظف خدمة العملاء...',
  
  // رسالة بعد التحويل
  afterTransferMessage: 'المحادثة الآن مع الموظف البشري',
};

export type DemoMessage = {
  id: string;
  sender: 'customer' | 'ai' | 'human' | 'system';
  message: string;
  timestamp: string;
};

export type DemoConversationState = {
  messages: DemoMessage[];
  isTransferred: boolean;
  isAITyping: boolean;
  isHumanTyping: boolean;
};
