import { escapeHtml } from '../auth/cookies';

/** Server-rendered pages of the access flow (no session yet, so not the web app). */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - orch</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
.who{display:flex;align-items:center;gap:.75rem;margin:1rem 0}.who img{width:48px;height:48px;border-radius:50%}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:.5rem}button{font:inherit;padding:.5rem 1rem;margin-top:.75rem;cursor:pointer}
.muted{color:#666;font-size:.9em}</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
${body}
<p><a href="/">Back to the start page</a></p>
</body></html>`;
}

function who(login: string, avatarUrl: string | null): string {
  const img =
    avatarUrl && /^https:\/\//.test(avatarUrl)
      ? `<img src="${escapeHtml(avatarUrl)}" alt="" referrerpolicy="no-referrer">`
      : '';
  return `<div class="who">${img}<strong>${escapeHtml(login)}</strong></div>`;
}

export const NOTE_MAX = 500;

/** No access yet: the request form (or the pending state, with the message still editable). */
export function requestAccessPage(opts: {
  login: string;
  avatarUrl: string | null;
  token: string;
  pending: boolean;
  note?: string | null;
  orgs: string[];
}): string {
  const intro = opts.pending
    ? '<p><strong>Request sent: an admin will review it.</strong> You can sign in again once it is approved.</p>'
    : '<p>This GitHub account does not have access to this orch server yet. Ask an admin for access:</p>';
  const orgs =
    opts.orgs.length > 0
      ? `<p class="muted">Active members of these GitHub organizations can sign in directly: ${escapeHtml(opts.orgs.join(', '))}.</p>`
      : '';
  const form = `<form method="post" action="/api/auth/access-request">
<input type="hidden" name="token" value="${escapeHtml(opts.token)}">
<label for="note">${opts.pending ? 'Update your message' : 'Message for the admins (optional)'}</label>
<textarea id="note" name="note" rows="4" maxlength="${NOTE_MAX}">${escapeHtml(opts.note ?? '')}</textarea>
<button type="submit">${opts.pending ? 'Update request' : 'Request access'}</button>
</form>`;
  return page(
    opts.pending ? 'Request sent' : 'Request access',
    `${who(opts.login, opts.avatarUrl)}${intro}${form}${orgs}`,
  );
}

export function requestSentPage(login: string, avatarUrl: string | null): string {
  return page(
    'Request sent',
    `${who(login, avatarUrl)}<p>Request sent: an admin will review it. You can sign in once it is approved.</p>`,
  );
}

export function declinedPage(login: string, avatarUrl: string | null): string {
  return page(
    'Access declined',
    `${who(login, avatarUrl)}<p>Your request was declined. This GitHub account cannot sign in to this orch server.</p>`,
  );
}

export function alreadyApprovedPage(login: string): string {
  return page(
    'Access approved',
    `${who(login, null)}<p>Your access is approved. <a href="/api/auth/github/login">Sign in with GitHub</a>.</p>`,
  );
}

export function requestExpiredPage(): string {
  return page(
    'Request expired',
    '<p>This access request form has expired or is invalid. <a href="/api/auth/github/login">Sign in with GitHub</a> again to request access.</p>',
  );
}

export function tooManyRequestsPage(): string {
  return page('Too many requests', '<p>Too many access requests. Try again later.</p>');
}

export function invalidInvitePage(): string {
  return page('Invalid invite', '<p>This invite link is invalid or has expired.</p>');
}
