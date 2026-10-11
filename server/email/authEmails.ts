// AUTH E-POSTA ŞABLONLARI — sade, metin öncelikli, Türkçe.
//
// Bağlantılar YALNIZ yapılandırılmış uygulama adresinden (APP_BASE_URL)
// üretilir; isteğin Host başlığından TÜRETİLMEZ (başlık sahteciliğiyle
// başka alan adına token sızdırılamaz).
import type { TransactionalEmail } from './emailProvider.ts'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((text) => `<p style="margin:0 0 14px;line-height:1.55">${escapeHtml(text)}</p>`).join('')
  const button = action
    ? `<p style="margin:22px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:11px 20px;border-radius:999px;background:#126ce5;color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>` +
      `<p style="margin:0 0 14px;color:#6e6e73;font-size:13px;line-height:1.5">Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:<br>${escapeHtml(action.url)}</p>`
    : ''
  return (
    `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1d1d1f">` +
    `<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px">` +
    `<p style="margin:0 0 18px;font-weight:700">CargoFlow</p>` +
    `<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>${body}${button}` +
    `<p style="margin:22px 0 0;color:#86868b;font-size:12px">Bu e-posta CargoFlow hesabınızla ilgili bir işlem nedeniyle gönderildi.</p>` +
    `</div></body></html>`
  )
}

export function verificationEmail(to: string, link: string): TransactionalEmail {
  const title = 'E-posta adresinizi doğrulayın'
  const lines = [
    'CargoFlow hesabınızı etkinleştirmek için e-posta adresinizi doğrulayın.',
    'Bağlantı 24 saat geçerlidir ve yalnız bir kez kullanılabilir.',
    'Bu kaydı siz yapmadıysanız bu e-postayı yok sayabilirsiniz.',
  ]
  return {
    to,
    kind: 'email_verification',
    subject: 'CargoFlow — e-posta doğrulama',
    text: `${title}\n\n${lines[0]}\n\n${link}\n\n${lines[1]}\n${lines[2]}`,
    html: layout(title, lines, { label: 'E-postamı doğrula', url: link }),
  }
}

export function passwordResetEmail(to: string, link: string): TransactionalEmail {
  const title = 'Şifre sıfırlama'
  const lines = [
    'CargoFlow hesabınız için şifre sıfırlama istendi.',
    'Bağlantı 30 dakika geçerlidir ve yalnız bir kez kullanılabilir.',
    'Bu isteği siz yapmadıysanız şifreniz değişmez; bu e-postayı yok sayabilirsiniz.',
  ]
  return {
    to,
    kind: 'password_reset',
    subject: 'CargoFlow — şifre sıfırlama',
    text: `${title}\n\n${lines[0]}\n\n${link}\n\n${lines[1]}\n${lines[2]}`,
    html: layout(title, lines, { label: 'Yeni şifre belirle', url: link }),
  }
}

/** Kayıtlı e-postayla yeniden kayıt denendi (hesap varlığı ekranda SIZDIRILMAZ). */
export function existingAccountNotice(to: string, loginLink: string, resetLink: string): TransactionalEmail {
  const title = 'Bu e-postayla zaten bir hesabınız var'
  const lines = [
    'Bu e-posta adresiyle yeni bir CargoFlow kaydı denendi; adresinize bağlı bir hesap zaten bulunuyor.',
    `Giriş yapmak için: ${loginLink}`,
    `Şifrenizi hatırlamıyorsanız: ${resetLink}`,
    'Bu denemeyi siz yapmadıysanız herhangi bir işlem yapmanız gerekmez.',
  ]
  return {
    to,
    kind: 'security_notice',
    subject: 'CargoFlow — hesap bildirimi',
    text: `${title}\n\n${lines.join('\n')}`,
    html: layout(title, lines),
  }
}

export function passwordChangedNotice(to: string, resetLink: string): TransactionalEmail {
  const title = 'Şifreniz değiştirildi'
  const lines = [
    'CargoFlow hesabınızın şifresi az önce değiştirildi ve açık oturumlarınız kapatıldı.',
    `Bu değişikliği siz yapmadıysanız hemen yeni bir şifre belirleyin: ${resetLink}`,
  ]
  return {
    to,
    kind: 'security_notice',
    subject: 'CargoFlow — şifreniz değiştirildi',
    text: `${title}\n\n${lines.join('\n')}`,
    html: layout(title, lines),
  }
}
