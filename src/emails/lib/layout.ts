import { config } from '../../config';

const CURRENT_YEAR = new Date().getFullYear();
const BASE_URL = config.appUrl;
const LOGO_URL = 'https://res.cloudinary.com/dy0cthb0l/image/upload/v1785093900/Kinkane_Logo_jodvx0.svg';
// System-UI stack — renders the platform's native sans-serif (SF Pro on Apple, Segoe UI on Windows, Roboto on Android/Chrome).
// Inter is the app font. Most modern email clients (Apple Mail, Gmail app, Outlook on Mac)
// will render it via the system stack; clients that don't will fall back gracefully.
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

/**
 * Wraps email body HTML in the branded Kinkané shell:
 * dark header → yellow hero band with title → white body → cream footer.
 *
 * Pass `unsubscribeUrl` for emails sent to known users (welcome, notifications,
 * digests). Omit for pure security emails (OTP, password reset) where
 * unsubscribing doesn't apply — the footer still renders but the link points
 * to the generic unsubscribe landing page.
 */
export function emailLayout(title: string, body: string, unsubscribeUrl?: string): string {
  const unsubscribeHref = unsubscribeUrl ?? `${BASE_URL}/unsubscribe`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#EEECE6;font-family:Georgia,'Times New Roman',serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEECE6;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#1A1A1A;padding:18px 32px;text-align:center;">
              <img src="${LOGO_URL}" alt="Kinkané" width="32" height="38" style="display:inline-block;vertical-align:middle;margin-right:10px;" /><span style="display:inline-block;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:bold;color:#FFFFFF;letter-spacing:0.3px;">Kinkané</span>
            </td>
          </tr>

          <!-- Hero band -->
          <tr>
            <td style="background-color:#F5E49C;padding:30px 48px;text-align:center;">
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:bold;color:#1A1A1A;line-height:1.35;">${title}</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#FFFFFF;padding:40px 48px;">
              <div style="font-family:${SANS};font-size:14px;font-weight:400;line-height:22.75px;letter-spacing:-0.15px;color:#1A1A1A;">
                ${body}
              </div>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="background-color:#FFFFFF;padding:0 48px;">
              <hr style="border:none;border-top:1px solid #E8E0D0;margin:0;" />
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#F5F0E8;padding:24px 48px;text-align:center;">
              <p style="margin:0 0 10px;font-family:${SANS};font-size:12px;color:#666666;line-height:1.5;">An amazing euphorium bringing the world's books to readers everywhere.</p>
              <p style="margin:0 0 10px;">
                <a href="${BASE_URL}/privacy" style="font-family:${SANS};font-size:12px;color:#555555;text-decoration:underline;">Privacy Notice</a>
                <span style="color:#BBBBBB;margin:0 8px;">&middot;</span>
                <a href="${BASE_URL}/terms" style="font-family:${SANS};font-size:12px;color:#555555;text-decoration:underline;">Terms of Use</a>
                <span style="color:#BBBBBB;margin:0 8px;">&middot;</span>
                <a href="${unsubscribeHref}" style="font-family:${SANS};font-size:12px;color:#555555;text-decoration:underline;">Unsubscribe</a>
              </p>
              <p style="margin:0;font-family:${SANS};font-size:11px;color:#999999;">&copy; ${CURRENT_YEAR} Kinkané &middot; 19 HP Nyemitei Street, Accra, Ghana</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Black pill CTA button, uppercase label — matches the Figma button style. */
export function ctaButton(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 4px;">
    <tr>
      <td style="background-color:#1A1A1A;border-radius:6px;text-align:center;">
        <a href="${url}" style="display:inline-block;padding:14px 32px;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:1.5px;color:#FFFFFF;text-decoration:none;text-transform:uppercase;">${text}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Individual digit boxes for OTP codes — matches the Figma verification code display.
 * Renders "YOUR VERIFICATION CODE" label above the digit row, plus the expiry note below.
 */
export function otpDisplay(otp: string, expiryMinutes: number = 15): string {
  const digitCells = otp
    .split('')
    .map(
      (d) =>
        `<td style="background-color:#F5F0E8;border:1px solid #E0D8C8;border-radius:5px;padding:14px 0;width:44px;font-family:${SANS};font-size:28px;font-weight:bold;color:#1A1A1A;text-align:center;">${d}</td><td style="width:8px;"></td>`,
    )
    .join('');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0;background-color:#F5F0E8;border:1px solid #E0D8C8;border-radius:8px;padding:0;">
    <tr>
      <td style="padding:24px 32px;text-align:center;">
        <p style="margin:0 0 16px;font-family:${SANS};font-size:10px;font-weight:bold;letter-spacing:3px;color:#999999;text-transform:uppercase;">Your Verification Code</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
          <tr>${digitCells}</tr>
        </table>
        <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;color:#888888;">This code will expire in ${expiryMinutes} minutes.</p>
      </td>
    </tr>
  </table>`;
}

/** Inline quote block for comment previews. */
export function quoteBlock(text: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;width:100%;">
    <tr>
      <td style="border-left:3px solid #E0D8C8;padding:10px 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#555555;line-height:1.65;">${text}</td>
    </tr>
  </table>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Convenience: wraps a string in a styled <p> tag. Last item should use margin:0. */
export function p(content: string, last = false): string {
  return `<p style="margin:0${last ? '' : ' 0 16px'};font-size:14px;font-weight:400;line-height:22.75px;letter-spacing:-0.15px;">${content}</p>`;
}
