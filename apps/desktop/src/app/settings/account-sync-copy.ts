import type { Locale } from '@/i18n'

const en = {
  discoveryLimited: 'History is still being scanned. Existing shared chats continue syncing.',
  incomplete: 'Some chats have not synced. Their local originals are preserved; sync is incomplete until these history or export limits are resolved.',
  savePreferences: 'Save language and appearance to account', applyPreferences: 'Apply account language and appearance',
  continueChat: 'Continue on this device',
  loading: 'Loading account sync…', retry: 'Try again', disableLocally: 'Turn sync off on this device',
  title: 'Account sync', consent: 'Enable sync for all chats', cancel: 'Cancel',
  description: 'All old and new chat text, titles and original dates are added to your Youtab account for your other devices. Local history is preserved. Credential stores, files and tool traces are not uploaded, but secrets written in chat text are included. Sync uses HTTPS, not end-to-end encryption.',
  unavailable: 'Account sync is unavailable. Sign in to Youtab, or try again when the service is available.',
  error: 'Sync did not finish. Pending changes are kept on this device. Try again.',
  sync: 'Sync now', local: 'Choose a local chat to share', share: 'Share chat',
  cloud: 'Chats in your account', empty: 'No shared chats yet.', remove: 'Delete from account',
  confirm: 'Delete this shared chat from your account and other synced devices? Local chat copies remain.',
  pending: 'Changes waiting to sync', channel: 'Release preference',
  channelRecommended: 'Recommended', channelEarlyAccess: 'Early access',
  channelDescription: 'Recommended delivers regular releases. Early access offers new versions sooner and may be less reliable.',
  channelError: 'Could not change your release preference. Try again.'
}

const fa: typeof en = {
  discoveryLimited: 'بررسی تاریخچه هنوز کامل نشده است. چت‌های مشترک همچنان همگام می‌شوند.',
  incomplete: 'برخی چت‌ها هنوز همگام نشده‌اند. نسخهٔ اصلی محلی محفوظ است؛ تا رفع محدودیت تاریخچه یا خطای دریافت، انتقال کامل نیست.',
  savePreferences: 'ذخیرهٔ زبان و ظاهر در حساب', applyPreferences: 'اعمال زبان و ظاهر حساب',
  continueChat: 'ادامهٔ چت روی این دستگاه',
  loading: 'در حال دریافت وضعیت همگام‌سازی…', retry: 'تلاش دوباره', disableLocally: 'خاموش‌کردن همگام‌سازی روی این دستگاه',
  title: 'همگام‌سازی حساب', consent: 'همگام‌سازی همهٔ چت‌ها', cancel: 'انصراف',
  description: 'متن، عنوان و زمان اصلی همهٔ چت‌های قدیمی و جدید به حساب Youtab شما اضافه می‌شود و تاریخچهٔ محلی حفظ می‌شود. مخزن کلیدها، فایل‌ها و رد ابزارها ارسال نمی‌شوند، اما اطلاعات محرمانهٔ نوشته‌شده در متن چت ارسال می‌شوند. انتقال با HTTPS است و رمزگذاری سرتاسری ندارد.',
  unavailable: 'همگام‌سازی حساب در دسترس نیست. وارد Youtab شوید یا پس از آماده‌شدن سرویس دوباره تلاش کنید.',
  error: 'همگام‌سازی کامل نشد. تغییرات ارسال‌نشده روی این دستگاه حفظ شده‌اند. دوباره تلاش کنید.',
  sync: 'همگام‌سازی اکنون', local: 'انتخاب چت محلی برای اشتراک', share: 'اشتراک چت',
  cloud: 'چت‌های حساب شما', empty: 'هنوز چتی به اشتراک گذاشته نشده است.', remove: 'حذف از حساب',
  confirm: 'این چت از حساب و دستگاه‌های همگام‌شده حذف شود؟ نسخه‌های محلی چت حفظ می‌شوند.',
  pending: 'تغییرات منتظر ارسال', channel: 'نوع دریافت به‌روزرسانی',
  channelRecommended: 'پیشنهادی', channelEarlyAccess: 'دسترسی زودهنگام',
  channelDescription: 'گزینهٔ پیشنهادی، نسخه‌های عمومی را دریافت می‌کند. دسترسی زودهنگام، نسخه‌های جدید را زودتر ارائه می‌کند و ممکن است پایداری کمتری داشته باشد.',
  channelError: 'تغییر نوع دریافت به‌روزرسانی انجام نشد. دوباره تلاش کنید.'
}

const nl: typeof en = {
  discoveryLimited: 'De geschiedenis wordt nog gescand. Gedeelde chats blijven synchroniseren.',
  incomplete: 'Sommige chats zijn nog niet gesynchroniseerd. Lokale originelen blijven behouden; de overdracht is onvolledig totdat de limieten of exportfouten zijn opgelost.',
  savePreferences: 'Taal en weergave opslaan in account', applyPreferences: 'Taal en weergave van account toepassen',
  continueChat: 'Doorgaan op dit apparaat',
  loading: 'Accountsynchronisatie laden…', retry: 'Opnieuw proberen', disableLocally: 'Synchronisatie op dit apparaat uitschakelen',
  title: 'Accountsynchronisatie', consent: 'Alle chats synchroniseren', cancel: 'Annuleren',
  description: 'Alle oude en nieuwe chattekst, titels en oorspronkelijke datums worden toegevoegd aan je Youtab-account. Lokale geschiedenis blijft behouden. Sleutelopslag, bestanden en toolsporen worden niet geüpload; geheimen in chattekst wel. Sync gebruikt HTTPS, geen end-to-endversleuteling.',
  unavailable: 'Accountsynchronisatie is niet beschikbaar. Meld je aan bij Youtab of probeer het opnieuw zodra de dienst beschikbaar is.',
  error: 'Synchronisatie is niet voltooid. Wachtende wijzigingen blijven op dit apparaat bewaard. Probeer opnieuw.',
  sync: 'Nu synchroniseren', local: 'Selecteer een lokale chat om te delen', share: 'Chat delen',
  cloud: 'Chats in je account', empty: 'Nog geen gedeelde chats.', remove: 'Verwijderen uit account',
  confirm: 'Deze gedeelde chat verwijderen uit je account en gesynchroniseerde apparaten? Lokale kopieën blijven behouden.',
  pending: 'Wijzigingen die wachten op synchronisatie', channel: 'Releasevoorkeur',
  channelRecommended: 'Aanbevolen', channelEarlyAccess: 'Vroege toegang',
  channelDescription: 'Aanbevolen levert reguliere versies. Vroege toegang biedt nieuwe versies eerder; deze kunnen minder betrouwbaar zijn.',
  channelError: 'Je releasevoorkeur kon niet worden gewijzigd. Probeer opnieuw.'
}

const zh: typeof en = {
  discoveryLimited: '仍在扫描历史记录。已共享的聊天继续同步。',
  incomplete: '部分聊天尚未同步。本地原始记录已保留；解决历史限制或导出错误之前，迁移仍不完整。',
  savePreferences: '将语言和外观保存到账户', applyPreferences: '应用账户语言和外观',
  continueChat: '在此设备继续',
  loading: '正在加载账户同步…', retry: '重试', disableLocally: '在此设备关闭同步',
  title: '账户同步', consent: '同步所有聊天', cancel: '取消',
  description: '所有旧、新聊天的文本、标题和原始时间将加入你的 Youtab 账户，本地历史保留。不上传凭据存储、文件或工具轨迹，但聊天文本中的秘密也会被上传。传输使用 HTTPS，不是端到端加密。',
  unavailable: '账户同步不可用。请登录 Youtab，或在服务可用时重试。',
  error: '同步未完成。待发送的更改仍保存在此设备上，请重试。',
  sync: '立即同步', local: '选择要共享的本地聊天', share: '共享聊天',
  cloud: '账户中的聊天', empty: '尚无共享聊天。', remove: '从账户删除',
  confirm: '从账户和同步设备删除此共享聊天？本地副本将保留。',
  pending: '等待同步的更改', channel: '版本偏好',
  channelRecommended: '推荐', channelEarlyAccess: '抢先体验',
  channelDescription: '推荐选项接收常规版本。抢先体验可更早获得新版本，但可靠性可能较低。',
  channelError: '无法更改版本偏好，请重试。'
}

const zhHant: typeof en = {
  discoveryLimited: '仍在掃描歷史記錄。已共享的聊天繼續同步。',
  incomplete: '部分聊天尚未同步。本機原始記錄已保留；解決歷史限制或匯出錯誤之前，移轉仍不完整。',
  savePreferences: '將語言和外觀儲存至帳戶', applyPreferences: '套用帳戶語言和外觀',
  continueChat: '在此裝置繼續',
  loading: '正在載入帳戶同步…', retry: '重試', disableLocally: '在此裝置關閉同步',
  title: '帳戶同步', consent: '同步所有聊天', cancel: '取消',
  description: '所有舊、新聊天的文字、標題和原始時間會加入你的 Youtab 帳戶，本機歷史保留。不上傳憑證儲存區、檔案或工具軌跡，但聊天文字中的機密也會上傳。傳輸使用 HTTPS，並非端對端加密。',
  unavailable: '帳戶同步無法使用。請登入 Youtab，或在服務可用時重試。',
  error: '同步未完成。待傳送的變更仍保存在此裝置上，請重試。',
  sync: '立即同步', local: '選擇要共享的本機聊天', share: '共享聊天',
  cloud: '帳戶中的聊天', empty: '尚無共享聊天。', remove: '從帳戶刪除',
  confirm: '從帳戶和同步裝置刪除此共享聊天？本機副本將保留。',
  pending: '等待同步的變更', channel: '版本偏好',
  channelRecommended: '建議', channelEarlyAccess: '搶先體驗',
  channelDescription: '建議選項接收一般版本。搶先體驗可提早取得新版本，但可靠性可能較低。',
  channelError: '無法變更版本偏好，請重試。'
}

const ja: typeof en = {
  discoveryLimited: '履歴のスキャンはまだ完了していません。共有済みチャットの同期は続きます。',
  incomplete: '一部のチャットは未同期です。ローカルの原本は保持されます。履歴制限やエクスポートの問題が解消するまで移行は未完了です。',
  savePreferences: '言語と外観をアカウントに保存', applyPreferences: 'アカウントの言語と外観を適用',
  continueChat: 'このデバイスで続ける',
  loading: 'アカウント同期を読み込み中…', retry: '再試行', disableLocally: 'このデバイスで同期をオフにする',
  title: 'アカウント同期', consent: 'すべてのチャットを同期', cancel: 'キャンセル',
  description: '過去と新しいチャットの本文、タイトル、元の日時を Youtab アカウントに追加し、ローカル履歴は保持します。認証情報ストア、ファイル、ツールの記録はアップロードしませんが、チャット本文に書かれた秘密情報は含まれます。通信は HTTPS で、エンドツーエンド暗号化ではありません。',
  unavailable: 'アカウント同期を利用できません。Youtab にログインするか、サービスが利用可能になったら再試行してください。',
  error: '同期が完了しませんでした。未送信の変更はこのデバイスに保存されています。再試行してください。',
  sync: '今すぐ同期', local: '共有するローカルチャットを選択', share: 'チャットを共有',
  cloud: 'アカウントのチャット', empty: '共有したチャットはありません。', remove: 'アカウントから削除',
  confirm: 'このチャットをアカウントと同期デバイスから削除しますか？ローカルのコピーは残ります。',
  pending: '同期待ちの変更', channel: 'リリース設定',
  channelRecommended: '推奨', channelEarlyAccess: '早期アクセス',
  channelDescription: '推奨では通常のリリースを受信します。早期アクセスでは新しいバージョンを先に利用できますが、信頼性が低い場合があります。',
  channelError: 'リリース設定を変更できませんでした。再試行してください。'
}

const ar: typeof en = {
  discoveryLimited: 'لا يزال فحص السجل جاريًا. تستمر مزامنة المحادثات المشتركة.',
  incomplete: 'لم تتم مزامنة بعض المحادثات. النسخ الأصلية المحلية محفوظة؛ النقل غير مكتمل حتى تُحل حدود السجل أو أخطاء التصدير.',
  savePreferences: 'حفظ اللغة والمظهر في الحساب', applyPreferences: 'تطبيق لغة الحساب ومظهره',
  continueChat: 'متابعة على هذا الجهاز',
  loading: 'جارٍ تحميل مزامنة الحساب…', retry: 'حاول مجددًا', disableLocally: 'إيقاف المزامنة على هذا الجهاز',
  title: 'مزامنة الحساب', consent: 'مزامنة جميع المحادثات', cancel: 'إلغاء',
  description: 'يُضاف نص جميع المحادثات القديمة والجديدة وعناوينها وأوقاتها الأصلية إلى حساب Youtab مع حفظ السجل المحلي. لا تُرفع مخازن بيانات الاعتماد أو الملفات أو آثار الأدوات، لكن الأسرار المكتوبة داخل نص المحادثة تُرفع أيضًا. النقل عبر HTTPS وليس تشفيرًا من طرف إلى طرف.',
  unavailable: 'مزامنة الحساب غير متاحة. سجّل الدخول إلى Youtab أو حاول عندما تتاح الخدمة.',
  error: 'لم تكتمل المزامنة. التغييرات المعلقة محفوظة على هذا الجهاز. حاول مجددًا.',
  sync: 'مزامنة الآن', local: 'اختر محادثة محلية للمشاركة', share: 'مشاركة المحادثة',
  cloud: 'محادثات حسابك', empty: 'لا توجد محادثات مشتركة بعد.', remove: 'حذف من الحساب',
  confirm: 'حذف هذه المحادثة من الحساب والأجهزة المتزامنة؟ ستبقى النسخ المحلية.',
  pending: 'تغييرات تنتظر المزامنة', channel: 'تفضيل الإصدارات',
  channelRecommended: 'موصى به', channelEarlyAccess: 'وصول مبكر',
  channelDescription: 'يوفر الخيار الموصى به الإصدارات المعتادة. يتيح الوصول المبكر الإصدارات الجديدة قبل ذلك، وقد تكون أقل موثوقية.',
  channelError: 'تعذر تغيير تفضيل الإصدارات. حاول مجددًا.'
}

const copies: Record<Locale, typeof en> = { en, fa, nl, zh, 'zh-hant': zhHant, ja, ar }
export const accountSyncCopy = (locale: Locale) => copies[locale]
