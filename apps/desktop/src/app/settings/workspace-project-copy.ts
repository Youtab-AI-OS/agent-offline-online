import type { Locale } from '@/i18n'

const en = {
  navProject: '+ PROJECT',
  navFiles: 'Files and folders',
  navTools: 'Tools',
  title: 'Project working copy',
  name: 'Project name',
  description:
    'Choose a source folder. Youtab creates a separate copy in <source>/Youtab/<project name> and selects that copy for new project chats. Existing projects and chats stay where they are.',
  choose: 'Choose folder and create project',
  preparing: 'Preparing the working copy…',
  exclusions:
    'The source folder is read only during copying. Existing Youtab working copies and Git metadata are excluded. Existing destinations are never overwritten.',
  boundary:
    'This is a working copy, not a sandbox. Terminal and computer-use tools can access other locations when permitted; review their approvals.',
  ready: 'Project created. New project chats use this working folder:',
  files: 'Files copied',
  localOnly:
    'Select a local Desktop gateway to create a local working copy. Remote projects keep their current folder workflow.',
  nativeRequired: 'Creating working copies requires the native Desktop application with this capability.',
  failed: 'The project was not opened.',
  copyKept: 'The working copy is kept at',
  contextChanged: 'The active profile or gateway changed. Choose the intended local profile before opening this copy.',
  projectNotCreated: 'The gateway did not confirm project creation.'
}

const fa: typeof en = {
  navProject: '+ پروژه',
  navFiles: 'فایل\u200cها و پوشه\u200cها',
  navTools: 'ابزارها',
  title: 'کپی کاری پروژه',
  name: 'نام پروژه',
  description:
    'پوشهٔ اصلی را انتخاب کنید. یک کپی جداگانه در <source>/Youtab/<project name> ساخته و برای چت‌های جدید این پروژه انتخاب می‌شود. محل پروژه‌ها و چت‌های قبلی تغییر نمی‌کند.',
  choose: 'انتخاب پوشه و ساخت پروژه',
  preparing: 'در حال آماده‌سازی کپی کاری…',
  exclusions:
    'هنگام کپی، پوشهٔ اصلی فقط خوانده می‌شود. کپی‌های قبلی Youtab و اطلاعات Git کپی نمی‌شوند. مسیر موجود بازنویسی نمی‌شود.',
  boundary:
    'این قابلیت کپی کاری است، نه محیط ایزوله. ابزار ترمینال و کنترل رایانه در صورت داشتن مجوز می‌توانند به مسیرهای دیگر دسترسی داشته باشند؛ تأیید اجرای ابزار را بررسی کنید.',
  ready: 'پروژه ساخته شد. چت‌های جدید این پروژه از این پوشه استفاده می‌کنند:',
  files: 'فایل‌های کپی‌شده',
  localOnly:
    'برای ساخت کپی روی این دستگاه، Gateway محلی Desktop را انتخاب کنید. روش فعلی پوشه‌های پروژهٔ راه‌دور حفظ می‌شود.',
  nativeRequired: 'ساخت کپی کاری به برنامهٔ Desktop دارای این قابلیت نیاز دارد.',
  failed: 'پروژه باز نشد.',
  copyKept: 'کپی کاری در این مسیر حفظ شده است',
  contextChanged: 'پروفایل یا Gateway فعال تغییر کرد. پیش از بازکردن کپی، پروفایل محلی موردنظر را انتخاب کنید.',
  projectNotCreated: 'ساخت پروژه از سوی Gateway تأیید نشد.'
}

const nl: typeof en = {
  navProject: '+ PROJECT',
  navFiles: 'Bestanden en mappen',
  navTools: 'Gereedschappen',
  title: 'Werkkopie van project',
  name: 'Projectnaam',
  description:
    'Kies een bronmap. Youtab maakt een aparte kopie in <bron>/Youtab/<projectnaam> voor nieuwe projectchats. Bestaande projecten en chats behouden hun locatie.',
  choose: 'Map kiezen en project maken',
  preparing: 'Werkkopie voorbereiden…',
  exclusions:
    'De bronmap wordt tijdens kopiëren alleen gelezen. Bestaande Youtab-werkkopieën en Git-metadata worden uitgesloten. Bestaande doelmappen worden nooit overschreven.',
  boundary:
    'Dit is een werkkopie, geen sandbox. Terminal- en computerbediening kunnen met toestemming andere locaties bereiken; controleer hun goedkeuringen.',
  ready: 'Project gemaakt. Nieuwe projectchats gebruiken deze werkmap:',
  files: 'Gekopieerde bestanden',
  localOnly:
    'Selecteer een lokale Desktop-gateway voor een lokale werkkopie. De bestaande werkwijze voor externe projecten blijft behouden.',
  nativeRequired: 'Werkkopieën maken vereist de native Desktop-app met deze functie.',
  failed: 'Het project is niet geopend.',
  copyKept: 'De werkkopie blijft bewaard in',
  contextChanged:
    'Het actieve profiel of de gateway is gewijzigd. Selecteer het bedoelde lokale profiel voordat je deze kopie opent.',
  projectNotCreated: 'De gateway heeft het maken van het project niet bevestigd.'
}

const zh: typeof en = {
  navProject: '+ 项目',
  navFiles: '文件和文件夹',
  navTools: '工具',
  title: '项目工作副本',
  name: '项目名称',
  description:
    '选择源文件夹。Youtab 在 <源文件夹>/Youtab/<项目名称> 创建独立副本，供新项目聊天使用。现有项目和聊天的位置保持不变。',
  choose: '选择文件夹并创建项目',
  preparing: '正在准备工作副本…',
  exclusions: '复制时仅读取源文件夹。不复制已有的 Youtab 工作副本和 Git 元数据。绝不覆盖已有目标。',
  boundary: '这是工作副本，不是沙盒。获准的终端和计算机操作工具仍可访问其他位置，请审查执行批准。',
  ready: '项目已创建。新项目聊天使用此工作文件夹：',
  files: '已复制文件',
  localOnly: '请选择本地 Desktop 网关以创建本地工作副本。远程项目保留现有文件夹流程。',
  nativeRequired: '创建工作副本需要支持此功能的原生 Desktop 应用。',
  failed: '项目未打开。',
  copyKept: '工作副本保留在',
  contextChanged: '当前配置文件或网关已更改。打开此副本前请选择所需的本地配置文件。',
  projectNotCreated: '网关未确认项目创建。'
}

const zhHant: typeof en = {
  navProject: '+ 專案',
  navFiles: '檔案與資料夾',
  navTools: '工具',
  title: '專案工作副本',
  name: '專案名稱',
  description:
    '選擇來源資料夾。Youtab 在 <來源>/Youtab/<專案名稱> 建立獨立副本，供新專案聊天使用。現有專案及聊天的位置保持不變。',
  choose: '選擇資料夾並建立專案',
  preparing: '正在準備工作副本…',
  exclusions: '複製時唯讀來源資料夾。不複製既有的 Youtab 工作副本與 Git 中繼資料。絕不覆寫既有目的地。',
  boundary: '這是工作副本，不是沙箱。經授權的終端與電腦操作工具仍可存取其他位置；請審查執行核准。',
  ready: '專案已建立。新專案聊天使用此工作資料夾：',
  files: '已複製檔案',
  localOnly: '請選擇本機 Desktop 閘道以建立本機工作副本。遠端專案保留現有資料夾流程。',
  nativeRequired: '建立工作副本需要支援此功能的原生 Desktop 應用程式。',
  failed: '專案未開啟。',
  copyKept: '工作副本保留於',
  contextChanged: '目前設定檔或閘道已變更。開啟此副本前請選擇所需的本機設定檔。',
  projectNotCreated: '閘道未確認專案建立。'
}

const ja: typeof en = {
  navProject: '+ プロジェクト',
  navFiles: 'ファイルとフォルダー',
  navTools: 'ツール',
  title: 'プロジェクトの作業コピー',
  name: 'プロジェクト名',
  description:
    '元のフォルダーを選択します。Youtab は <元のフォルダー>/Youtab/<プロジェクト名> に独立したコピーを作成し、新しいプロジェクトチャットで使います。既存のプロジェクトとチャットの場所は変わりません。',
  choose: 'フォルダーを選んでプロジェクトを作成',
  preparing: '作業コピーを準備中…',
  exclusions:
    'コピー中は元のフォルダーを読み取るだけです。既存の Youtab 作業コピーと Git メタデータは除外します。既存のコピーは上書きしません。',
  boundary:
    'これは作業コピーであり、サンドボックスではありません。許可されたターミナルやコンピューター操作は他の場所にもアクセスできます。実行承認を確認してください。',
  ready: 'プロジェクトを作成しました。新しいチャットはこの作業フォルダーを使用します：',
  files: 'コピーしたファイル',
  localOnly:
    'ローカル作業コピーにはローカル Desktop ゲートウェイを選択してください。リモートプロジェクトは既存のフォルダー操作を維持します。',
  nativeRequired: '作業コピーの作成には、この機能を備えたネイティブ Desktop アプリが必要です。',
  failed: 'プロジェクトは開かれませんでした。',
  copyKept: '作業コピーの保存先',
  contextChanged:
    '有効なプロファイルまたはゲートウェイが変わりました。コピーを開く前に目的のローカルプロファイルを選択してください。',
  projectNotCreated: 'ゲートウェイがプロジェクト作成を確認しませんでした。'
}

const ar: typeof en = {
  navProject: '+ مشروع',
  navFiles: 'الملفات والمجلدات',
  navTools: 'الأدوات',
  title: 'نسخة عمل المشروع',
  name: 'اسم المشروع',
  description:
    'اختر مجلد المصدر. ينشئ Youtab نسخة مستقلة في <المصدر>/Youtab/<اسم المشروع> للمحادثات الجديدة. تبقى مواقع المشاريع والمحادثات الحالية كما هي.',
  choose: 'اختيار مجلد وإنشاء مشروع',
  preparing: 'جارٍ إعداد نسخة العمل…',
  exclusions:
    'تُقرأ ملفات المصدر فقط أثناء النسخ. تُستثنى نسخ Youtab الحالية وبيانات Git. لا تُستبدل الوجهات الموجودة.',
  boundary:
    'هذه نسخة عمل وليست بيئة معزولة. يمكن لأدوات الطرفية والتحكم بالكمبيوتر الوصول إلى مواقع أخرى عند منح الإذن؛ راجع موافقات التنفيذ.',
  ready: 'أُنشئ المشروع. تستخدم المحادثات الجديدة مجلد العمل التالي:',
  files: 'الملفات المنسوخة',
  localOnly: 'اختر بوابة Desktop محلية لإنشاء نسخة محلية. يبقى مسار مجلدات المشاريع البعيدة كما هو.',
  nativeRequired: 'إنشاء نسخ العمل يتطلب تطبيق Desktop الأصلي الذي يدعم هذه الميزة.',
  failed: 'لم يُفتح المشروع.',
  copyKept: 'نسخة العمل محفوظة في',
  contextChanged: 'تغير ملف التعريف أو البوابة النشطة. اختر ملف التعريف المحلي المطلوب قبل فتح النسخة.',
  projectNotCreated: 'لم تؤكد البوابة إنشاء المشروع.'
}

const copies: Record<Locale, typeof en> = { en, fa, nl, zh, 'zh-hant': zhHant, ja, ar }
export const workspaceProjectCopy = (locale: Locale) => copies[locale]
