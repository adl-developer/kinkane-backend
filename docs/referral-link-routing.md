# Referral link routing — required frontend config

**Status: not yet applied. Until it is, click tracking records nothing in
production.**

## The problem

Referral links are built from `APP_URL`, so they look like:

```
https://kinkane.app/r/K7M3QP9XVT/jason-appiatu
```

But the handler that resolves the code, records the click and issues the
redirect lives on **this API server**, which is deployed separately (Render).
`kinkane.app` is the client.

So in production the link lands on the frontend, which has no `/r` route. The
click is never recorded and the visitor gets a 404 instead of the invite page.

This does not show up in local development, where `APP_URL=http://localhost:3000`
is the API server itself — the link works, and tracking works, which is exactly
why the gap is easy to miss.

Signups would still attribute correctly (the code travels in the signup body via
the landing page or the `kk_ref` cookie), so the symptom is a `clicks` figure
stuck at 0 while `signups` climbs — which reads like a broken counter rather than
a routing problem.

## The fix

Proxy `/r/*` from the client host to the API host. This keeps the public link on
`kinkane.app`, which matters: the link is pasted into WhatsApp and read by
humans, and `kinkane-server.onrender.com/r/...` looks like something you
shouldn't click.

Apply **one** of the following in the frontend project, replacing the API host
with the real one.

### Next.js (`next.config.js`)

```js
module.exports = {
  async rewrites() {
    return [
      {
        source: '/r/:path*',
        destination: 'https://kinkane-server.onrender.com/r/:path*',
      },
    ];
  },
};
```

### Vercel, without Next.js (`vercel.json`)

```json
{
  "rewrites": [
    { "source": "/r/:path*", "destination": "https://kinkane-server.onrender.com/r/:path*" }
  ]
}
```

### Netlify (`_redirects`)

```
/r/*  https://kinkane-server.onrender.com/r/:splat  200
```

Note the `200` rather than `301`: it proxies rather than redirecting, so the
browser never sees the API host.

## Two things to get right

**Rewrite, not redirect.** A `301`/`302` from the frontend would work, but it
adds a round trip and exposes the API hostname in the address bar mid-hop. A
rewrite/proxy keeps both hidden.

**Do not cache it.** The endpoint has a side effect — it writes a click row — so
a CDN caching the response would serve the redirect without the request ever
reaching the API, and tracking would silently under-report. The handler sets no
cache headers, but if the frontend host applies a blanket cache policy to
proxied paths, exclude `/r/*`.

## Verifying it works

Once applied, from anywhere:

```bash
curl -sI "https://kinkane.app/r/<a-real-code>/anything?c=whatsapp" | head -3
```

Expect `HTTP/1.1 302` and a `Location:` header pointing at
`https://kinkane.app/invite?ref=<CODE>&c=whatsapp`. A `404` means the rewrite
isn't in place. Then check the owning user's `GET /api/v1/referrals/me/stats` —
`clicks` should have gone up by one.

Note that `curl` will **not** move the counter: its user agent is flagged as a
bot and excluded from the figure. Use a real browser to test the count, or
check the raw `referral_clicks` table, where bot rows are still recorded with
`is_bot = true`.

## Alternative, if the rewrite can't be applied

Add a `REFERRAL_LINK_BASE` env var defaulting to `APP_URL`, and point it at the
API host. Links then work with no frontend change, at the cost of every shared
message carrying the API hostname. Not implemented — the rewrite is a better
trade, and this is only worth building if the frontend genuinely can't proxy.
