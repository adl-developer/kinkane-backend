# Recover from a webhook handler crash on Stripe's next retry

**Date:** 2026-08-13
**Commit:** [36ea9ef](https://adl.github.com/adl-developer/kinkane-backend/commit/36ea9ef44c069795160d2da0453405829f27ca03)

## What changed

Stripe's webhook idempotency guard in `webhooksService.claimEvent` now
recognises the difference between "this event was already fully handled"
(skip) and "an earlier attempt started but never finished" (redo it).

An entry in `stripe_webhook_events` with a `processed_at` set means the
handler completed — a duplicate delivery for that event is dropped as
before. An entry with `processed_at` still `NULL` and a `received_at` older
than **60 seconds** is treated as an abandoned claim from a crashed
handler, and reclaimed. The next Stripe redelivery picks up where the
crashed one left off.

```ts
await db
  .insert(stripeWebhookEvents)
  .values({ eventId: event.id, type: event.type, payload: ... })
  .onConflictDoUpdate({
    target: stripeWebhookEvents.eventId,
    set: { receivedAt: sql`now()`, payload: sql`EXCLUDED.payload` },
    setWhere: sql`${stripeWebhookEvents.processedAt} IS NULL
                  AND ${stripeWebhookEvents.receivedAt}
                      < now() - interval '60 seconds'`,
  });
```

## Why

Stripe delivers each webhook multiple times specifically so a mid-handler
crash doesn't permanently drop the work. Our old flow claimed the event
row *before* running the handler — so if the process died halfway through,
the row was still there, and every retry Stripe sent after that was
silently dropped as a duplicate. The state change or audit row that the
handler was supposed to write never landed, and there was no obvious
signal that anything had gone wrong.

## Non-obvious decisions

- **60-second reclaim window.** Comfortably longer than any handler could
  plausibly take (the slowest do a handful of Stripe API calls, well under
  30 s), and shorter than Stripe's redelivery cadence. A still-running
  instance is never preempted by a redelivery that races with it.
- **Payload is overwritten on reclaim.** `EXCLUDED.payload` — the redelivered
  event carries the freshest object shape from Stripe, which is what the
  handler should operate on.
- **Deliberately not a full distributed lock.** This is a best-effort crash
  recovery, not perfect exactly-once delivery. Every handler downstream has
  its own idempotency guard (state guards, `onConflictDoNothing`, BullMQ job
  dedup) so a two-instance overlap in the narrow reclaim window is safe.

## Verified

TypeScript compilation clean. Semantics follow from the SQL logic:

- No row exists → INSERT succeeds → row returned → claimed.
- Row exists with `processedAt` set → conflict → `setWhere` false → no
  update → nothing returned → not claimed (correct duplicate skip).
- Row exists with `processedAt` NULL, recent → conflict → `setWhere`
  false (age check) → nothing returned → not claimed (another instance
  is still processing).
- Row exists with `processedAt` NULL, older than 60s → conflict →
  `setWhere` true → update runs → row returned → reclaimed.

End-to-end crash-and-retry simulation against Stripe test-mode is left
for staging verification.
