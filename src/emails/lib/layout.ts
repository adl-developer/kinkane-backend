import { config } from '../../config';

const CURRENT_YEAR = new Date().getFullYear();
const BASE_URL = config.appUrl;
const LOGO_URL = 'https://res.cloudinary.com/dy0cthb0l/image/upload/v1785093900/Kinkane_Logo_jodvx0.svg';
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

/**
 * Wraps email body HTML in the branded Kinkané shell:
 * dark header → yellow hero band → white body → cream footer.
 *
 * Pass `unsubscribeUrl` for user-targeted emails. Omit for security emails
 * (OTP, password reset) — the Unsubscribe link is hidden entirely in that case.
 */
export function emailLayout(title: string, body: string, unsubscribeUrl?: string): string {
  const footerLinks = unsubscribeUrl
    ? `<a href="${BASE_URL}/privacy" style="font-family:${SANS};font-size:12px;color:#52514E;text-decoration:underline;">Privacy Notice</a>
                <span style="color:#C5C5C4;margin:0 8px;">&middot;</span>
                <a href="${BASE_URL}/terms" style="font-family:${SANS};font-size:12px;color:#52514E;text-decoration:underline;">Terms of Use</a>
                <span style="color:#C5C5C4;margin:0 8px;">&middot;</span>
                <a href="${unsubscribeUrl}" style="font-family:${SANS};font-size:12px;color:#52514E;text-decoration:underline;">Unsubscribe</a>`
    : `<a href="${BASE_URL}/privacy" style="font-family:${SANS};font-size:12px;color:#52514E;text-decoration:underline;">Privacy Notice</a>
                <span style="color:#C5C5C4;margin:0 8px;">&middot;</span>
                <a href="${BASE_URL}/terms" style="font-family:${SANS};font-size:12px;color:#52514E;text-decoration:underline;">Terms of Use</a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#EEECE6;font-family:${SANS};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EEECE6;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:#262626;padding:32px 40px;text-align:center;">
              <img src="${LOGO_URL}" alt="Kinkané" width="28" height="33" style="display:inline-block;vertical-align:middle;margin-right:12px;" /><span style="display:inline-block;vertical-align:middle;font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:400;color:#FFFFFF;letter-spacing:0.5px;">Kinkané</span>
            </td>
          </tr>

          <!-- Hero band -->
          <tr>
            <td style="background-color:#FFF18A;padding:24px 40px;text-align:center;">
              <h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;color:#262626;line-height:32px;">${title}</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#FFFFFF;padding:40px;">
              <div style="font-family:${SANS};font-size:14px;font-weight:400;line-height:22.75px;letter-spacing:-0.15px;">
                ${body}
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#F5F0E8;border-top:1px solid #E8E8E7;padding:32px 40px;text-align:center;">
              <p style="margin:0 0 12px;font-family:${SANS};font-size:12px;color:#52514E;line-height:16px;">An amazing euphorium bringing the world's books to readers everywhere.</p>
              <p style="margin:0 0 16px;">
                ${footerLinks}
              </p>
              <p style="margin:0;font-family:${SANS};font-size:12px;color:rgba(82,81,78,0.50);line-height:16px;">&copy; ${CURRENT_YEAR} Kinkané &middot; 19 HP Nyemitei Street, Accra, Ghana</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Greeting line — #262626, slightly heavier visual weight than body paragraphs. */
export function greeting(name: string): string {
  return `<p style="margin:0 0 24px;font-family:${SANS};font-size:14px;font-weight:400;line-height:20px;color:#262626;">Hi ${name},</p>`;
}

/**
 * Divider + sign-off section — always ends with "The Kinkané Team".
 * `disclaimer` renders in small muted text (disclaimers, security notes, closings like "Happy reading,").
 */
export function signOff(disclaimer?: string): string {
  const disclaimerHtml = disclaimer
    ? `<p style="margin:0 0 12px;font-family:${SANS};font-size:12px;font-weight:400;line-height:19.5px;color:rgba(82,81,78,0.70);">${disclaimer}</p>`
    : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:20px;border-top:1px solid #E8E8E7;">
    <tr>
      <td style="padding-top:32px;">
        ${disclaimerHtml}<p style="margin:0;font-family:${SANS};font-size:14px;font-weight:400;line-height:20px;color:#52514E;">The Kinkané Team</p>
      </td>
    </tr>
  </table>`;
}

/** Black CTA button, uppercase label — matches the Figma button style. */
export function ctaButton(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
    <tr>
      <td style="background-color:#262626;border-radius:6px;text-align:center;">
        <a href="${url}" style="display:inline-block;padding:14px 32px;font-family:${SANS};font-size:12px;font-weight:bold;letter-spacing:1.5px;color:#FFFFFF;text-decoration:none;text-transform:uppercase;">${text}</a>
      </td>
    </tr>
  </table>`;
}

/**
 * Individual digit boxes for OTP codes — matches the Figma verification code display.
 * White boxes with #E8E8E7 outline, Georgia digits, cream container.
 */
export function otpDisplay(otp: string, expiryMinutes: number = 15): string {
  const digitCells = otp
    .split('')
    .map(
      (d) =>
        `<td style="width:44px;height:56px;background-color:#FFFFFF;outline:1px solid #E8E8E7;text-align:center;vertical-align:middle;"><span style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;color:#262626;line-height:32px;">${d}</span></td>`,
    )
    .join('<td style="width:12px;"></td>');

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 0;background-color:#F5F0E8;border-radius:6px;outline:1px solid #E8E8E7;">
    <tr>
      <td style="padding:32px 24px;text-align:center;">
        <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;font-weight:400;letter-spacing:3.6px;color:#52514E;text-transform:uppercase;line-height:16px;">Your Verification Code</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
          <tr>${digitCells}</tr>
        </table>
        <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;color:rgba(82,81,78,0.60);line-height:16px;">This code will expire in ${expiryMinutes} minutes.</p>
      </td>
    </tr>
  </table>`;
}

/** Inline quote block for comment previews. */
export function quoteBlock(text: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0;width:100%;">
    <tr>
      <td style="border-left:3px solid #E8E8E7;padding:10px 16px;font-family:Georgia,'Times New Roman',serif;font-size:14px;color:#52514E;line-height:1.65;">${text}</td>
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

/** Paragraph — body text colour #52514E. Use `last: true` to remove bottom margin. */
export function p(content: string, last = false): string {
  return `<p style="margin:0${last ? '' : ' 0 20px'};font-family:${SANS};font-size:14px;font-weight:400;line-height:22.75px;letter-spacing:-0.15px;color:#52514E;">${content}</p>`;
}
