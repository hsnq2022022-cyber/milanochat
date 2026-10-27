/** UI-only translation: never rewrite user-authored flow documents. */
export type FlowLanguage="ar"|"en";
const messages={
  designer:["إدارة سوشيال / مصمم الأتمتة","Social Management / Flow Builder"],
  draft:["مسودة","Draft"],
  back:["الرجوع إلى لوحة التحكم","Back to dashboard"],
  name:["اسم التدفق","Flow name"],
  select:["اختيار التدفق","Select flow"],
  create:["إنشاء تدفق جديد","Create flow"],
  blank:["البدء من الصفر","Start from scratch"],
  duplicate:["نسخ التدفق","Duplicate flow"],
  delete:["حذف التدفق الحالي","Delete current flow"],
  collapse:["طي شريط أدوات التدفقات","Hide flow toolbar"],
  expand:["إظهار شريط أدوات التدفقات","Show flow toolbar"],
  hideTools:["طي الأدوات","Hide tools"],
  showTools:["إظهار الأدوات","Show tools"],
  enabled:["مفعّل محليًا","Locally enabled"],
  disabled:["معطّل","Disabled"],
  activate:["تفعيل التدفق","Toggle flow activation"],
  undo:["تراجع Ctrl+Z","Undo Ctrl+Z"],
  redo:["إعادة Ctrl+Shift+Z","Redo Ctrl+Shift+Z"],
  add:["إضافة خطوة","Add step"],
  addShort:["إضافة","Add"],
  arrange:["ترتيب تلقائي","Auto-layout"],
  arrangeShort:["ترتيب","Arrange"],
  check:["فحص التدفق","Validate flow"],
  checkShort:["فحص","Check"],
  preview:["تجربة","Preview"],
  export:["تصدير","Export"],
  import:["استيراد","Import"],
  save:["حفظ","Save"],
  openAdd:["فتح إضافة خطوة","Open step picker"],
  stepProps:["خصائص العقدة","Step properties"],
  close:["إغلاق المحرر","Close editor"],
  collapseStep:["طي إعدادات الخطوة","Collapse step settings"],
  expandStep:["إظهار إعدادات الخطوة","Expand step settings"],
  done:["تم","Done"],
  closeLabel:["إغلاق","Close"],
  title:["عنوان الخطوة","Step title"],
  channel:["القناة التي يبدأ منها التدفق","Starting channel"],
  event:["نوع الحدث","Event type"],
  answer:["نوع الإجابة","Response type"],
  next:["الخطوة التالية بعد الإجابة","Next step after answer"],
  localOnly:["التفعيل والتعطيل محليان فقط — لا توجد أتمتة حقيقية للحسابات المرتبطة","Activation here is local only — connected accounts do not run automations yet"],
  panel:["إعدادات الخطوة","Step settings"],
  noNode:["اختر عقدة من مساحة العمل لتعديل محتواها.","Choose a node on the canvas to edit it."],
  testFlow:["تجربة: ","Preview: "],
  reset:["إعادة","Restart"],
  noMeta:["رسائل وهمية فقط — دون Meta أو خصم رصيد","Simulation only — no Meta messages or credit charges"],
  closePreview:["إغلاق المعاينة","Close preview"],
  customerAnswer:["إجابة العميل","Customer response"],
  submit:["إرسال الإجابة","Submit response"],
  completed:["اكتملت المحاكاة.","Preview completed."],
  steps:["الخطوات: ","Steps: "],
  flowIssues:["فحص التدفق","Flow validation"],
  noIssues:["لا توجد مشاكل في المسودة.","No issues found."],
  addAfter:["إضافة خطوة بعد المسار","Add step after branch"],
  addNew:["إضافة خطوة جديدة","Add new step"],
  menuClose:["إغلاق قائمة الإضافة","Close step picker"],
  language:["لغة الواجهة","Interface language"],
} as const;
const kindLabels={
 trigger:"Trigger",message:"Send message",question:"Question / collect data",
 condition:"Condition",delay:"Delay",action:"Action",randomizer:"Randomizer",
 goto:"Go to step",request:"External request",end:"End"
} as const;
export function flowKindLabel(kind:keyof typeof kindLabels,language:FlowLanguage,arabic:string):string{
 return language==="en"?kindLabels[kind]:arabic;
}
export type FlowUIText=keyof typeof messages;
export function flowText(key:FlowUIText,language:FlowLanguage):string{
  const phrase=messages[key];
  return phrase[language==="ar"?0:1];
}
