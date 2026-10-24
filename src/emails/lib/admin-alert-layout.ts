const CURRENT_YEAR = new Date().getFullYear();
const LOGO_URL = 'https://res.cloudinary.com/dy0cthb0l/image/upload/v1785093900/Kinkane_Logo_jodvx0.svg';
const SANS = "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

// The admin alert palette, from the Figma "Email Template" page. Navy rather
// than the customer emails' black-and-yellow, so staff can tell an alert from
// a copy of something a customer was sent at a glance.
const NAVY = '#1E2A38';
const BAND = '#E8EEF5';
const PANEL = '#F0F4F8';
const RULE = '#CBD5E1';
const ACCENT = '#3D5A80';
const LABEL = '#8B95A1';
const BODY = '#52514E';

/**
 * The shell for emails to Kinkané staff: navy header with "Admin Alert",
 * pale blue band with an eyebrow and title, white body, navy footer.
 *
 * No privacy/terms links and no unsubscribe: these go to an internal inbox,
 * and the footer says so instead.
 */
export function adminAlertLayout(eyebrow: string, title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#E8E4DC;font-family:${SANS};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#E8E4DC;">
    <tr>
      <td align="center" style="padding:48px 16px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="max-width:620px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background-color:${NAVY};padding:32px 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
                <tr>
                  <td valign="middle">
                    <img src="${LOGO_URL}" alt="Kinkané" width="28" height="33" style="display:inline-block;vertical-align:middle;margin-right:12px;" /><span style="display:inline-block;vertical-align:middle;font-family:${SERIF};font-size:20px;font-weight:400;color:#FFFFFF;letter-spacing:0.5px;">Kinkané</span>
                  </td>
                  <td valign="middle" align="right" style="font-family:${SANS};font-size:12px;line-height:16px;letter-spacing:2.4px;text-transform:uppercase;color:${LABEL};">Admin Alert</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Band -->
          <tr>
            <td style="background-color:${BAND};border-bottom:1px solid ${RULE};padding:24px 40px;text-align:center;">
              <p style="margin:0 0 8px;font-family:${SANS};font-size:12px;line-height:16px;letter-spacing:2.4px;text-transform:uppercase;color:${ACCENT};">${eyebrow}</p>
              <h1 style="margin:0;font-family:${SERIF};font-size:24px;font-weight:400;line-height:32px;color:${NAVY};">${title}</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background-color:#FFFFFF;padding:40px;">
              ${body}
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:40px;border-top:1px solid #E8E8E7;">
                <tr>
                  <td style="padding-top:32px;font-family:${SANS};font-size:14px;line-height:20px;color:${BODY};">Kinkané Admin System</td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:${NAVY};padding:24px 40px;text-align:center;">
              <p style="margin:0 0 4px;font-family:${SANS};font-size:12px;line-height:18px;color:rgba(255,255,255,0.45);">This is an automated alert sent to Kinkané administrators only. Do not forward or share.</p>
              <p style="margin:0;font-family:${SANS};font-size:12px;line-height:18px;color:rgba(255,255,255,0.35);">&copy; ${CURRENT_YEAR} Kinkané &middot; 19 HP Nyemitei Street, Accra, Ghana</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** The opening paragraph, in body grey. */
export function alertIntro(text: string): string {
  return `<p style="margin:0 0 28px;font-family:${SANS};font-size:14px;line-height:22.75px;letter-spacing:-0.15px;color:${BODY};">${text}</p>`;
}

/** One labelled value in the details panel. `wide` takes both columns. */
export interface DetailField {
  label: string;
  /** Already escaped. */
  value: string;
  wide?: boolean;
}

function fieldCell(f: DetailField, colspan = 1): string {
  return `<td valign="top" ${colspan > 1 ? 'colspan="2"' : 'width="50%"'} style="padding:0 12px 16px 0;">
                <p style="margin:0 0 2px;font-family:${SANS};font-size:12px;line-height:16px;color:${LABEL};">${f.label}</p>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:20px;color:${NAVY};">${f.value}</p>
              </td>`;
}

/**
 * "Report details": a two-column grid of fields, filled left to right, with
 * `wide` fields on a row of their own. A table rather than a CSS grid, which
 * Outlook's Word renderer cannot lay out.
 *
 * `quote`, when given, sits under a rule at the bottom, in italics — the
 * reported post or comment.
 */
export function detailsPanel(fields: DetailField[], quote?: { label: string; text: string }): string {
  const rows: string[] = [];
  let pending: DetailField | null = null;
  for (const f of fields) {
    if (f.wide) {
      if (pending) rows.push(`<tr>${fieldCell(pending)}<td width="50%"></td></tr>`);
      pending = null;
      rows.push(`<tr>${fieldCell(f, 2)}</tr>`);
    } else if (pending) {
      rows.push(`<tr>${fieldCell(pending)}${fieldCell(f)}</tr>`);
      pending = null;
    } else {
      pending = f;
    }
  }
  if (pending) rows.push(`<tr>${fieldCell(pending)}<td width="50%"></td></tr>`);

  const quoteHtml = quote
    ? `<tr>
              <td colspan="2" style="padding:12px 0 16px;border-top:1px solid ${RULE};">
                <p style="margin:0 0 4px;font-family:${SANS};font-size:12px;line-height:16px;color:${LABEL};">${quote.label}</p>
                <p style="margin:0;font-family:${SANS};font-size:14px;line-height:22px;font-style:italic;color:${BODY};">&ldquo;${quote.text}&rdquo;</p>
              </td>
            </tr>`
    : '';

  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${PANEL};border:1px solid ${RULE};border-radius:6px;">
    <tr>
      <td style="padding:24px 28px 8px;">
        <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:16px;letter-spacing:2.4px;text-transform:uppercase;color:${ACCENT};">Report Details</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
          ${rows.join('\n          ')}
          ${quoteHtml}
        </table>
      </td>
    </tr>
  </table>`;
}

/** Navy pill button, centred, uppercase. */
export function alertButton(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0;">
    <tr>
      <td style="background-color:${NAVY};border-radius:999px;text-align:center;">
        <a href="${url}" style="display:inline-block;padding:16px 36px;font-family:${SANS};font-size:13px;font-weight:500;letter-spacing:0.5px;color:#FFFFFF;text-decoration:none;text-transform:uppercase;">${text}</a>
      </td>
    </tr>
  </table>`;
}
