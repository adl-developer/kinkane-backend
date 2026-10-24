import { config } from '../../config';

const CURRENT_YEAR = new Date().getFullYear();
const BASE_URL = config.appUrl;
const LOGO_URL = 'https://res.cloudinary.com/dy0cthb0l/image/upload/v1785093900/Kinkane_Logo_jodvx0.svg';
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
// Moderation notices: sand band, gold accents, cream panel — from the Email Template page.
const NOTICE_BAND = '#F3E6C4';
const NOTICE_BORDER = '#EAD08A';
const NOTICE_ACCENT = '#9A7424';
const NOTICE_PANEL = '#FDF6E8';

/**
 * Wraps email body HTML in the branded Kinkané shell:
 * dark header → yellow hero band → white body → cream footer.
 *
 * Pass `unsubscribeUrl` only for promotional email — the newsletter, book
 * recommendations, reading reminders and the weekly digest. Those are exactly
 * the emails the unsubscribe route can actually switch off.
 *
 * Omit it everywhere else (security, billing, follow requests, trial-ending,
 * welcome): those keep sending after an unsubscribe, so showing the link would
 * hand the user a confirmation page for something that doesn't stop.
 *
 * Pass `notice` for moderation notices: the hero band turns from yellow to the
 * muted sand of the design and carries a small eyebrow ("COMMUNITY NOTICE")
 * above the title, so a notice never reads like good news.
 */
export function emailLayout(title: string, body: string, unsubscribeUrl?: string, notice?: { eyebrow: string }): string {
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
            <td style="background-color:${notice ? NOTICE_BAND : '#FFF18A'};padding:24px 40px;text-align:center;${notice ? `border-bottom:1px solid ${NOTICE_BORDER};` : ''}">
              ${notice ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:500;letter-spacing:2.4px;text-transform:uppercase;color:${NOTICE_ACCENT};line-height:16px;">${notice.eyebrow}</p>` : ''}<h1 style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:400;color:#262626;line-height:32px;">${title}</h1>
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
 * OTP code as a single unbroken string on a cream container, so it can be
 * selected and copied in one go. Spacing is letter-spacing only — no extra
 * characters end up on the clipboard.
 */
export function otpDisplay(otp: string, expiryMinutes: number = 15): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:20px 0 0;background-color:#F5F0E8;border-radius:6px;">
    <tr>
      <td style="padding:32px 24px;text-align:center;">
        <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;font-weight:400;letter-spacing:3.6px;color:#52514E;text-transform:uppercase;line-height:16px;">Your Verification Code</p>
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:32px;font-weight:400;letter-spacing:8px;color:#262626;line-height:40px;white-space:nowrap;">${otp}</p>
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

/**
 * The cream panel of a moderation notice: a small gold label ("CONTENT
 * REMOVED", "WHAT THIS MEANS") over `inner`, which is noticeDetails or
 * noticeBullets.
 */
export function noticePanel(label: string, inner: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:4px 0 24px;background-color:${NOTICE_PANEL};border:1px solid ${NOTICE_BORDER};border-radius:6px;">
    <tr>
      <td style="padding:20px 24px;">
        <p style="margin:0 0 14px;font-family:${SANS};font-size:11px;font-weight:500;letter-spacing:2.4px;text-transform:uppercase;color:${NOTICE_ACCENT};line-height:16px;">${label}</p>
        ${inner}
      </td>
    </tr>
  </table>`;
}

/** Label-over-value rows for noticePanel ("Type", "Submitted on"). Values are escaped. */
export function noticeDetails(rows: { label: string; value: string }[]): string {
  return rows
    .map(
      (r, i) => `<p style="margin:0;font-family:${SANS};font-size:11px;color:rgba(82,81,78,0.70);line-height:16px;">${escapeHtml(r.label)}</p>
        <p style="margin:2px 0 ${i === rows.length - 1 ? 0 : 12}px;font-family:${SANS};font-size:14px;color:#262626;line-height:20px;">${escapeHtml(r.value)}</p>`,
    )
    .join('\n');
}

/** Gold-dotted bullet list for noticePanel. Items are escaped. */
export function noticeBullets(items: string[]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
    ${items
      .map(
        (item) => `<tr>
      <td style="width:18px;vertical-align:top;padding:0 0 10px;font-family:${SANS};font-size:14px;line-height:22px;color:${NOTICE_ACCENT};">&bull;</td>
      <td style="vertical-align:top;padding:0 0 10px;font-family:${SANS};font-size:14px;line-height:22px;color:#262626;">${escapeHtml(item)}</td>
    </tr>`,
      )
      .join('\n')}
  </table>`;
}

/**
 * The appeal button: a centred dark pill that opens a reply to `email`, with
 * the address written beneath it for anyone whose client will not follow a
 * mailto link.
 */
export function appealButton(text: string, email: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px auto 4px;">
    <tr>
      <td style="background-color:#262626;border-radius:999px;text-align:center;">
        <a href="mailto:${email}" style="display:inline-block;padding:14px 36px;font-family:${SANS};font-size:12px;font-weight:600;letter-spacing:1.5px;color:#FFFFFF;text-decoration:none;text-transform:uppercase;">${text}</a>
      </td>
    </tr>
  </table>
  <p style="margin:0 0 24px;text-align:center;font-family:${SANS};font-size:11px;color:rgba(82,81,78,0.60);line-height:16px;">${escapeHtml(email)}</p>`;
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

/**
 * Book card — cover thumbnail beside the title and author, on the cream panel.
 *
 * Laid out as a two-cell table rather than floats or flexbox: Outlook's Word
 * renderer supports neither, and this is the only email surface that pairs an
 * image with text. The cover is given explicit width/height attributes as well
 * as CSS so the card doesn't collapse while the image loads or when images are
 * blocked entirely — in that case the `alt` text stands in for the jacket.
 *
 * Pass `coverUrl` as null when the book has no jacket on file: the cell is
 * dropped rather than rendering a broken image, and the text takes the full
 * width. Covers are hotlinked from wherever the catalogue stores them, so the
 * URL must be https — Gmail proxies images and silently drops http ones.
 */
export function bookCard(
  title: string,
  author: string,
  coverUrl: string | null,
  url: string,
): string {
  const coverCell =
    coverUrl && coverUrl.startsWith('https://')
      ? `<td width="96" valign="top" style="width:96px;padding-right:20px;">
              <a href="${url}" style="text-decoration:none;"><img src="${coverUrl}" alt="${title}" width="96" style="display:block;width:96px;max-width:96px;height:auto;border:0;border-radius:4px;outline:1px solid #E8E8E7;" /></a>
            </td>`
      : '';

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 20px;background-color:#F5F0E8;border-radius:6px;outline:1px solid #E8E8E7;">
    <tr>
      <td style="padding:24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
          <tr>
            ${coverCell}
            <td valign="top">
              <p style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:18px;font-weight:400;line-height:26px;color:#262626;"><a href="${url}" style="color:#262626;text-decoration:none;">${title}</a></p>
              <p style="margin:0;font-family:${SANS};font-size:13px;font-weight:400;line-height:20px;color:#52514E;">by ${author}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}
