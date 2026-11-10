# Renewal reminder emails a week before every renewal

## What changed

A new daily job (09:00 UTC) emails every website (Stripe) subscriber whose
renewal is within the next 7 days, once per renewal:

- **Normal renewal:** "Your Kinkané Plus membership renews soon", with the date
  and the amount that will be charged.
- **Founding price ending:** "Your Founding Member price ends soon", with the
  founding price they've been paying and the standard price from this renewal.

Both versions say you don't need to do anything, and that you can change plan
or cancel any time before the renewal date. They link to the subscription
screen.

## Why

Client request on 2026-11-10. Under the new one-period founding rule, every
founding member's second payment is a price rise, and a price rise nobody was
told about tends to come back as a chargeback.

## How it works

- **Amounts come from Stripe's invoice preview** (its total, before any
  account credit), so they match what the renewal costs, including tax or
  discounts. For a founding member, the job first makes sure the switch to
  standard is set up in Stripe, then previews. The founding wording is used
  only when the renewal's own price is no longer a founding price. A
  difference in totals caused by tax or credit never triggers it.
- **A pending plan switch** takes effect at this renewal, so the email names
  the plan being switched to.
- **Sent once per renewal:** new column
  `user_subscriptions.renewal_reminder_sent_for` (migration `0093`) records
  the `current_period_end` that was reminded. A conditional update claims it,
  so several server processes running the job together can't double-send. On
  a Stripe or queue failure the claim is released and the next day's run
  retries.
- **Who's left out:** App Store subscribers (Apple bills them and sends its
  own notices), subscriptions set to cancel at period end (nothing renews),
  and past-due subscriptions.

## Verification

Integration tests on a scratch Postgres (`renewal-founding.integration.test.ts`)
cover these cases:

- one email per renewal, and another for the next period
- renewals more than 7 days out, cancelling subscriptions and Apple
  subscribers are skipped
- the founding wording, and the normal wording when Stripe still bills founding
- a retry after a Stripe failure

The templates were rendered with Resend stubbed out and reviewed by the
client. No real email was sent.
