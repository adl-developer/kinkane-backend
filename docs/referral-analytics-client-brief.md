# Referral Analytics charts — client-side brief

**Audience:** whoever (human or agent) renders the referral Analytics screen.
That client lives in a repo separate from this backend.

**This document is self-contained.** Endpoint, full response shape, what to
change, and the traps are all below. No other file is needed.

**Backend status:** shipped and verified against a live database. Nothing is
pending on the server side.

---

## 1. The one-line version

`GET /api/v1/referrals/analytics` returns a `weekly` array that used to be
**exactly 8 entries, a rolling window ending this week**. It is now **one entry
per week of the competition, from week 1 through the week in progress**, and
each entry carries its own week number and dates.

If the client labels bars `Wk ${index + 1}`, those labels are wrong today and
were wrong before this change too. Label from `weekNumber`.

---

## 2. Why it changed

The screen has two charts — **Weekly Referrals** (grouped bars, Sent vs
Converted) and **Cumulative Signups** (line). Both were plotted from an
8-element array with labels derived from the array index, so:

- "Wk 1" meant *"eight weeks before today"*. It pointed at a different calendar
  week every Monday.
- Nothing in the payload said what dates any bar covered, so no tooltip could
  say either.
- The cumulative line's running total restarted from an arbitrary point eight
  weeks back, rather than from the start of the competition.

The competition is "Around the World in 80 Days", which has a real start date.
The charts now count from it.

---

## 3. Endpoint

```
GET /api/v1/referrals/analytics
```

- **No authentication.** Every figure is a campaign-wide aggregate; the only
  people named are top referrers, first name only.
- **Rate limit:** 120 requests per 15 minutes per IP. A `429` returns
  `{ "error": "Too many requests — please try again later" }`.
- **Served from a 5-minute server-side cache.** All callers get identical bytes.
  Do not poll it faster than that expecting fresher numbers, and do not build a
  live-ticking counter on it — figures can lag reality by up to five minutes.

---

## 4. Response shape

```jsonc
{
  "totals": {
    "sent": 1247,          // invites initiated by referrers
    "clicks": 1180,        // unique link taps, bots excluded
    "signups": 412,        // everyone who signed up with a code
    "successful": 389,     // of those, email-verified — the ones that scored
    "conversionRate": 31.2,// successful ÷ clicks, percent to 1dp. See §7.
    "countries": 14,
    "continents": 3
  },

  "weekly": [
    {
      "weekNumber": 1,          // NEW — 1-based week of the campaign
      "weekStart": "2026-08-03",// Monday, UTC
      "weekEnd": "2026-08-09",  // NEW — Sunday, UTC, inclusive
      "sent": 190,
      "converted": 61,
      "cumulative": 61          // running total of `converted`
    }
    // ... one entry per week, through the week in progress
  ],

  "topReferrers": [
    { "rank": 1, "name": "Kwame", "country": "GH", "signups": 47, "points": 620 }
  ]
}
```

### What changed in `weekly`

| Field | Status |
| --- | --- |
| `weekNumber` | **New.** 1-based week of the campaign. |
| `weekEnd` | **New.** Sunday closing the bucket, inclusive. |
| `weekStart` | Unchanged (Monday, UTC, `YYYY-MM-DD`). |
| `sent`, `converted`, `cumulative` | Unchanged. |
| array length | **Was always 8. Now variable.** |

Nothing was removed and nothing was renamed, so an existing client will not
crash — it will keep rendering, and keep mislabelling. That is the whole point
of the change.

---

## 5. What the client needs to do

1. **Label bars from `weekNumber`, never from the array index.** `Wk ${w.weekNumber}`.
2. **Stop assuming 8 buckets.** Size the axis from `weekly.length`. Any hardcoded
   8 — a fixed bar width, a preallocated array, a chart config, a skeleton
   loader with eight placeholder bars — needs to become dynamic.
3. **Handle a 1-element array.** Before the campaign has run a week (and in any
   fresh dev or staging environment) `weekly` has exactly one entry. The chart
   must render a single bar without collapsing or dividing by zero.
4. **Handle a long array.** Over a ~12-week campaign this reaches ~12 bars, and
   it keeps growing after the campaign ends (see §7). Decide now whether the
   bar chart scrolls horizontally, compresses, or windows to the last N — this
   is a client-side presentation decision, the API returns everything.
5. **Use `weekStart`/`weekEnd` in tooltips.** e.g. `Wk 3 · 17–23 Aug`. These are
   plain `YYYY-MM-DD` date strings, **not** timestamps — parse them as UTC
   dates, and do not run them through a local-timezone `new Date()` that could
   shift them a day.
6. **Drive the Cumulative Signups line from `cumulative`.** Do not recompute a
   running total client-side from `converted`; the server's is already anchored
   to week 1 of the campaign.

---

## 6. Reference: how the server picks week 1

Only relevant for making sense of the numbers you get back — there is nothing to
implement here.

- Week 1 starts at the **Monday on or before** `REFERRAL_CAMPAIGN_STARTS_AT`
  (a backend env var). All buckets are Monday-based UTC.
- If that env is unset, week 1 falls back to the **earliest invite ever sent**.
  That is why a dev or staging environment still shows a sensible chart.
- If neither exists (nothing sent yet), the window is the current week alone —
  one bucket.

---

## 7. Traps

**Week 1 can be a partial week.** If the competition starts mid-week — say a
Wednesday — week 1 covers only Wednesday to Sunday but is bucketed from its
Monday. It will read low. That is a genuine dip in the data, not a rendering
bug. Do not "fix" it by dropping or rescaling the first bucket. If it needs
explaining in the UI, `weekStart`/`weekEnd` give you the real range.

**Quiet weeks are real zeroes, not gaps.** Every week in the window is returned
whether or not anything happened. A week of zero is a fact worth drawing; do not
filter empty buckets out, or the chart draws a straight line across a quiet
period and it reads as steady rather than as quiet.

**The array grows after the campaign ends.** The window is not capped at a
campaign end date — deliberately, since the only end-date env exists to switch
invite copy and overloading it would tie two unrelated behaviours together. So
once the competition closes, a trailing empty bucket appears every week. If the
screen should freeze or change after the campaign, raise it with the backend
rather than special-casing it in the client — the fix belongs server-side.

**`conversionRate` is an upper bound, not a true funnel.** It can exceed 100%.
Two reasons, both real: a code typed into the "Have an invite code?" field on
signup credits a referral with no click behind it, and taps that open an already
installed app never reach the server unless the client reports them via
`POST /referrals/clicks`. Both push the same way. Do not render it as a
progress bar or a filled gauge that breaks past 100, and do not add a
"% of target" framing on top of it.

**`topReferrers` is ranked by signups, not points.** It is a different ordering
from `/api/v1/referrals/leaderboard`, which ranks by points. Someone with three
cross-continent referrals outscores someone with fifteen domestic ones, so "top
referrer" is genuinely two different people depending on the question. Both
figures are in the response so you can show either without a second call — just
do not label the signups ordering as the leaderboard.

---

## 8. Verification the backend already did

Run against a live database, both configurations:

- **Unconfigured:** fell back to the earliest invite (2026-08-31, a Monday) →
  one bucket, `weekNumber: 1`, the invite counted in it.
- **Wednesday start (`2026-08-05`):** snapped to Monday `2026-08-03` → five
  buckets through the current week, four quiet weeks at zero, the invite landing
  in `weekNumber: 5`.

Unit tests cover the Monday snap, the growing window, the partial first week, a
future start date, and densification of quiet weeks.
