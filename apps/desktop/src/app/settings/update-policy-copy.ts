import type { Locale } from '@/i18n'

const en = {
  title: 'Update preferences',
  enable: 'Enable updates',
  description:
    'Allow explicit online checks and installation of verified update packages. Off by default. Turning this off prevents update checks and installation.',
  automatic: 'Check online automatically',
  automaticDescription:
    'Check for releases at startup, on focus and periodically. Off by default; no automatic installation.',
  offline: 'Import offline update',
  offlineDescription:
    'Choose a signed update bundle from this device or USB. Import verifies the package and opens its release notes for review; it does not install it. No account sign-in or Internet is required.',
  loading: 'Reading update preferences',
  importing: 'Verifying the selected bundle',
  error: 'Update preferences could not be read or saved. No new permission was confirmed.',
  importError: 'The update bundle was not imported. The previous update selection is preserved.',
  retry: 'Try again',
  disabled: 'Updates are turned off on this device.',
  manualOnly: 'Updates are enabled. Online checks run only when you request them.'
}

const fa: typeof en = {
  title: 'تنظیمات به‌روزرسانی',
  enable: 'فعال‌کردن به‌روزرسانی',
  description:
    'اجازهٔ بررسی دستی آنلاین و نصب بستهٔ تأییدشدهٔ به‌روزرسانی. پیش‌فرض خاموش است. با خاموش‌کردن، بررسی و نصب به‌روزرسانی متوقف می‌شود.',
  automatic: 'بررسی خودکار آنلاین',
  automaticDescription:
    'بررسی نسخه‌ها هنگام شروع، بازگشت به پنجره و در بازه‌های زمانی. پیش‌فرض خاموش است؛ نصب خودکار انجام نمی‌شود.',
  offline: 'انتخاب بستهٔ به‌روزرسانی آفلاین',
  offlineDescription:
    'بستهٔ امضاشده را از این دستگاه یا USB انتخاب کنید. ابتدا بسته بررسی و توضیحات نسخه برای تأیید شما باز می‌شود؛ نصب شروع نمی‌شود. ورود به حساب و اینترنت لازم نیست.',
  loading: 'خواندن تنظیمات به‌روزرسانی',
  importing: 'بررسی بستهٔ انتخاب‌شده',
  error: 'خواندن یا ذخیرهٔ تنظیمات به‌روزرسانی انجام نشد. اجازهٔ جدیدی تأیید نشده است.',
  importError: 'بستهٔ به‌روزرسانی وارد نشد. انتخاب قبلی به‌روزرسانی حفظ شده است.',
  retry: 'تلاش دوباره',
  disabled: 'به‌روزرسانی روی این دستگاه خاموش است.',
  manualOnly: 'به‌روزرسانی فعال است. بررسی آنلاین فقط با درخواست شما انجام می‌شود.'
}

export const updatePolicyCopy = (locale: Locale) => (locale === 'fa' ? fa : en)
