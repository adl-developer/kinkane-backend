# Referral charts count weeks from the start of the competition

**Date:** 2026-09-02

## What changed

The two charts on the referral Analytics screen — Weekly Referrals and
Cumulative Signups — were plotting a rolling window of the last eight weeks,
labelled Wk 1 to Wk 8. Those labels were an artefact of the array: "Wk 1" meant
"eight weeks before today", so it pointed at a different week every Monday, and
nothing in the response said which dates any bar actually covered.

They now run from week one of the "Around the World in 80 Days" competition
through the week in progress. Week 1 is week 1 of the campaign and stays there,
the window grows by a bucket each week, and every bucket carries its own dates.

Each entry in `weekly` gained two fields:

```json
{
  "weekNumber": 5,
  "weekStart": "2026-08-31",
  "weekEnd": "2026-09-06",
  "sent": 12,
  "converted": 4,
  "cumulative": 17
}
```

Clients should label bars from `weekNumber` rather than from the array index.
Nothing was removed, so an existing client keeps working — it just keeps
mislabelling, which is what this change exists to fix.

## Where the start date comes from

A new optional `REFERRAL_CAMPAIGN_STARTS_AT`, alongside the
`REFERRAL_CAMPAIGN_ENDS_AT` that already switches invite copy. ISO 8601.

Unset, it falls back to the earliest invite anyone has ever sent. For a deploy
nobody has configured, that is the honest answer — the campaign effectively
began when someone first shared a link — and it means local and staging
environments produce a sensible chart with no setup. Setting it explicitly is
still better: it survives that first invite being deleted, and it lets the
charts cover a launch window that opened before anyone shared anything. With
neither (no config, nothing sent yet) the window is the current week alone,
rather than a fabricated eight weeks of zeroes.

## Non-obvious decisions

**A mid-week start snaps back to its Monday.** Buckets stay Monday-based UTC so
that Postgres's `date_trunc('week')` keeps doing the grouping. Anchoring the
boundaries to the exact start date instead would mean bucketing by elapsed-day
arithmetic, and it would put the chart's weeks out of step with every other
weekly figure in the system. The cost is that a campaign launched on a
Wednesday has a partial week 1, which will read low — that is a real dip in the
data, not a rendering bug, and it is visible in the `weekStart`/`weekEnd` pair.

**The window grows rather than rolls.** Over a ~12-week campaign that is at most
a dozen bars, and it means a bar's position carries meaning: week 3 is week 3 in
December as much as it was in August. It also makes the cumulative chart honest,
since a rolling window's running total restarted from an arbitrary point.

**A start date in the future still emits one bucket.** An empty `weekly` array
would render a chart with no axis at all.

**The cache key moved to `referrals:analytics:v2`.** The response shape changed
and the old key would have served week-less payloads for five minutes after
deploy.

## Out of scope

The window does not stop at `REFERRAL_CAMPAIGN_ENDS_AT`. That variable's job is
switching invite copy, and overloading it to also freeze the charts would tie
two unrelated behaviours to one value. It does mean that once the competition
ends, the charts keep growing a trailing empty bucket every week — worth
revisiting when there is an actual end date set, most likely as its own decision
about what the screen should show after the campaign closes.

## Verification

Unit tests cover the Monday snap, the growing window, the partial first week,
the future-start guard, and densification of quiet weeks. The aggregate was also
run against the local database both unconfigured (fell back to the first invite,
2026-08-31, one bucket, the invite landing in it) and with a Wednesday start of
2026-08-05 (snapped to Monday 2026-08-03, five buckets, four quiet weeks at zero
and the invite in week 5).
