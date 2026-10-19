# Referral cumulative chart always ends at the signup total

## What changed

- **Cumulative line fixed.** The weekly `cumulative` line on referral analytics, in both the public app endpoint and the admin console, now starts from the signups made before week 1 of the chart. Its last point always equals the total-signups card.
- **New verified-signup series.** Each week now also carries `successful` (that week's signups that are now verified) and `cumulativeSuccessful`, whose last point equals the "successful signups" card. Both fields are additive, so existing clients are unaffected.
- **Admin search escaped.** The Travellers search now treats `%` and `_` literally.

## Why

The running total used to start at zero on the first week drawn. Signups from before that week were counted in the total but never in the line, so the line ended below the total. This happens whenever `REFERRAL_CAMPAIGN_STARTS_AT` is later than the first referrals, which it is in `.env`. It also happens when a referral predates the first recorded invite.

Separately, the only cumulative line counted every signup, while the "successful" card counts only verified ones. A console showing both had no line that matched that card.

## Decisions

- **Starting totals come from the existing query.** They are two extra `filter` counts on the totals query, not a new query.
- **Public cache key bumped** (`v2` → `v3`), so no cached response without the new fields is served after deploy.
- **Weekly `successful` is counted by signup week**, not verification week. That keeps each bucket a subset of `converted`.

## Verified

The admin referrals integration test now backdates one signup to 2020, before any window. It checks that both cumulative lines end at their totals. With the starting total removed, the test fails (2 vs 3). A new test checks that `_` in a search matches literally.
