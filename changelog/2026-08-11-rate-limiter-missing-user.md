# Rate limiters no longer 500 when a request has no authenticated user

**Date:** 2026-08-11

## What changed

Four rate limiters are keyed by the authenticated user rather than by IP —
checkout, verify-email OTP, resend-verification, and follow requests. Each of
them read the user id like this:

```ts
keyGenerator: (req: Request) => String((req as AuthenticatedRequest).user.id),
```

They now share one helper that falls back to the caller's IP when there is no
user on the request:

```ts
const byUser = (req: Request): string => {
  const id = (req as AuthenticatedRequest).user?.id;
  return id !== undefined ? String(id) : ipKeyGenerator(req.ip ?? '');
};
```

## Why

The cast is doing real work in that original line: `req.user` is not actually
guaranteed to exist at the type level, and the `as` silences the compiler rather
than establishing that it does. Every one of these limiters currently sits
behind `requireAuth`, so in practice the field is always there — but "in
practice" is carried entirely by route-registration order, which is invisible
from the limiter definition and one careless edit away from changing.

If it ever is absent, `.user.id` throws a `TypeError` *inside*
express-rate-limit, before the handler runs. That surfaces as an unexplained
500 with a stack trace pointing into a dependency, on a route that is otherwise
working — which is a bad afternoon to debug for something a `?.` prevents.

A limiter is a safety control. When it cannot identify the caller it should
degrade to limiting *more* narrowly, not fail the request.

## The IPv6 detail

The fallback uses express-rate-limit's own `ipKeyGenerator` rather than `req.ip`
directly. It collapses an IPv6 address to its /56 prefix:

```
2001:db8:1234:5678:9abc:def0:1234:5678  →  2001:db8:1234:5600::/56
```

A single IPv6 client is typically handed a whole address range, so keying on the
full address would let it sidestep the limit entirely by changing the low bits
on every request. IPv4 addresses pass through unchanged.

## Scope

No behavior change on any request that has an authenticated user, which is every
request these four limiters currently see. This is a guard against a failure
mode, not a fix for one that is happening.

## Verified

`ipKeyGenerator` checked against an IPv4 address, an IPv6 address and an empty
string; type-checked across all four call sites.
