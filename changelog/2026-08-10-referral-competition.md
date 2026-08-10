# Invite a friend, and the "Around the World" competition

**Date:** 2026-08-10

## What changed

Any signed-up user can now invite friends with a personal link, share it over
WhatsApp, SMS or email, and earn points based on **where in the world their code
gets used**. The full referral tree is tracked, so an admin can see who referred
whom to any depth.

The link looks like this:

```
https://kinkane.com/r/K7M3QP9XVT/jason-appiatu
```

The code in the middle is what identifies the referrer. The name on the end is
decorative — it is never used to look anything up. That is deliberate: people
change their display name, and a link already sitting in someone's WhatsApp
thread has to keep working afterwards. It also means the name segment can be
regenerated from the user's *current* name every time a link is rendered.

Codes are 10 characters of Crockford base32 with `I`, `L`, `O` and `U` removed,
because a referral code gets read off a screen and retyped far more often than a
password does. They are random rather than derived from the user id — a
derivable code would be an enumerable one, and enumerating codes would expose
the user list.

## Who can refer

Everyone with an account. Not gated behind Kinkané Plus.

There are three subscription states in the system and all three can refer:
trialing, paid, and **gated** (trial expired, now read-only). That last one
needed care. A gated user is read-only by design, but generating a referral link
*is* a write — it inserts a code row — and so is sending an invite. The referral
routes therefore apply `requireAuth` **without** `requirePlus`. If a future
blanket write-gate sweeps them in, gated users will start getting a 402 on the
invite screen and the feature will quietly stop working for exactly the people
it is meant to bring back.

## Scoring

Scored on the referrer's country versus the country the code was redeemed in:

| Condition | Points |
|---|---|
| Same country | 1 |
| Different country, same continent | 10 |
| Different continent | 20 |
| Full circuit — "around the world" | 30 |

The first three apply to **direct referrals only**. Only the circuit rule walks
the deep tree. The alternative — every ancestor scoring on every descendant —
would make a user's score grow without further effort and turn the leaderboard
into a function of join date.

**A circuit** is a path down someone's referral tree that starts on their
continent, leaves it, and comes back. Tom in Ghana refers Ama in France; Ama
refers Lisa in Nigeria; Tom has gone around the world. It is a property of a
*path*, not of a subtree, and it is awarded **once per user** — per-path would be
unbounded, since a wide tree could collect 30 points repeatedly for what is meant
to read as a single achievement.

Worth knowing for the UI: a user's direct points are settled the moment each
friend signs up, but **a circuit can arrive at any time**, from someone several
levels down whom they have never met, potentially months later.

Points count **at signup**, not on email verification. An earlier design held
them until the referred user verified their email, to stop disposable inboxes
farming a prize. There are no prizes, so that hold bought nothing and cost the
referrer a confusing delay between "my friend joined" and "my score moved".

## Invite copy, and the campaign switch

The words are supplied marketing copy, held verbatim — emoji, em dashes and
curly apostrophes included. They live in one module
([referral-copy.ts](../src/lib/referral-copy.ts)) rather than inside the
share-payload builder and the email template separately, because both need the
same words and they must not drift: someone who copies the WhatsApp text and
someone who sends the email should be sending the same message.

There are two sets, and which one is in force is decided by
`REFERRAL_CAMPAIGN_ENDS_AT`:

- **Launch** — the "Around the World in 80 Days" copy, while now is before that
  date.
- **Evergreen** — the plain "I think you'll like this" copy, after it.

Unset means evergreen. That is the safe default rather than an arbitrary one:
the launch copy promises a challenge, and sending it when no campaign is running
is a promise the product doesn't keep. This mirrors how `FOUNDING_OFFER_ENDS_AT`
gates launch pricing.

`GET /referrals/me` now returns `campaign` alongside the payloads, so a client
can key its own UI — a progress meter, campaign artwork — off the same decision
the copy used instead of re-deriving it from a date it would have to be told.

Two things worth knowing about the copy as supplied:

- **It no longer carries the marketing video.** Neither copy set has a slot for
  it. `REFERRAL_VIDEO_URL` still exists and is still returned by
  `GET /referrals/me`, but nothing injects it into a message. Dropped from the
  email job payload accordingly.
- **Neither the subject nor the body says who sent it.** The copy is first
  person throughout — "come with me", "my link" — but never names the sender, so
  a recipient would get a personal-sounding note from a brand they've never heard
  of. The sender's name therefore rides in the From display name:
  `Jason via Kinkane <no-reply@kinkane.app>`. The address stays ours, so SPF,
  DKIM and DMARC are unaffected — this is the standard mailing-list pattern, not
  spoofing. The name is sanitised before it goes in: it is user-controlled and
  lands in a mail header, where CR/LF would allow header injection outright and
  quotes or angle brackets would break the RFC 5322 parse.

## Data model

Four new tables, plus three columns on `users` and one on `guest_sessions`.

**`referral_codes`** — one active code per user, minted lazily the first time
they open the invite screen. Its own table rather than a column on `users` so a
code can be rotated without touching the user row.

**`referral_clicks`** — click funnel. The IP is stored hashed; nothing in scoring
reads this table.

**`referrals`** — the edge table. The important column is
`referred_user_id UNIQUE`: **a user is referred exactly once, ever.** That single
constraint makes the graph a forest of trees rather than an arbitrary digraph,
which is what makes circuit detection a bounded walk instead of a cycle search.

It also carries `ancestor_path` — the ordered list of ancestor user ids, root
first. Computed once at insert (`parent.ancestor_path || parent.referrer`) and
never updated, because a node's parent never changes. With a GIN index this turns
"everyone below user X, at any depth" into one containment scan and "is there a
circuit through this node" into an array read, with no recursive CTE anywhere.

`referrer_country`, `redeemer_country` and `referrer_tier_at_referral` are
**snapshots taken at redemption**, not joins. Users travel and subscriptions
convert; a live join would silently restate the score of every past referral
whenever they did.

**`referral_points`** — an append-only ledger. A score is a `SUM` over this
table, never a counter on `users`. Every point stays traceable to the referral
that produced it, and a bad referral is reversed by voiding its rows rather than
by arithmetic. Two constraints do real work: `UNIQUE(referral_id, kind)` makes a
retried award a no-op, and a partial unique index on `(user_id, season_id) WHERE
kind = 'full_circuit'` enforces once-per-user circuits at the database level
rather than trusting the detection code to run exactly once.

`season_id` defaults to 1 and does nothing yet. The competition is currently
unbounded, but adding this column later would mean backfilling a live points
table and touching every scoring query — lopsided enough to carry it now.

**`countries`** — ISO 3166-1 alpha-2 → continent, seeded by `npm run db:init`.
Only the six habitable continents exist as enum values; Antarctica is not one, so
a user who geolocates there has no continent and scores nothing.

Deliberately **not** referenced by a foreign key from `users.country_code`: a geo
lookup can legitimately return a code the seed doesn't carry, and under an FK
that would abort the signup transaction. An account must never fail to be created
because we can't place it on a map.

## Geography

This is the part with real uncertainty, and it deserves stating plainly: every
point in this competition depends on a field that did not exist before this
change and has no wholly reliable source.

Country is resolved once, at signup, from two optional sources tried in order:

1. A trusted geo header from a CDN or proxy (`GEO_COUNTRY_HEADER` — e.g.
   `cf-ipcountry`). Only consulted when that env var names one, because any
   client can forge a header: trusting one while the origin is reachable
   directly would hand users a free country picker.
2. A local MaxMind GeoLite2 database (`MAXMIND_DB_PATH`). The `maxmind` package
   is an optional dependency loaded through a dynamic import, so a deployment
   without it degrades rather than failing to boot.

**Both unset is a supported configuration** — and is what CI and local
development run. Signups then carry no country and score nothing, which is
strictly better than guessing.

Country is **never re-derived on later logins**. Someone travelling must not
silently change continent mid-competition. Corrections are admin-only
(`PATCH /admin/users/:id/country`); a self-service country field would make the
whole exercise pointless. Someone in Ghana whose ISP geolocates to the UK is a
certainty at any scale, and that is a competition dispute rather than a bug.

## Endpoints

| Route | Notes |
|---|---|
| `GET /api/v1/referrals/me` | Link + prebuilt WhatsApp/SMS/mailto payloads. `requireAuth` only |
| `POST /api/v1/referrals/me/rotate` | New code, old one revoked; past attributions unaffected |
| `GET /api/v1/referrals/me/stats` | Own funnel, points by kind, circuit status, countries reached |
| `GET /api/v1/referrals/leaderboard` | Public. First name and country only |
| `POST /api/v1/referrals/invite` | Emails the invite. 202 — queued, not sent. 20/hour |
| `GET /r/:code/:slug` | Public redirect + click capture. Mounted at the root, not under `/api/v1` |
| `POST /api/v1/guest-sessions/:id/referral` | Parks a code on a guest session so it survives to signup |
| `GET /admin/referrals/tree?userId=&depth=` | The map |
| `GET /admin/referrals/leaderboard` | Unredacted standings |
| `POST /admin/referrals/:id/void` | Void a referral and its direct points |
| `PATCH /admin/users/:id/country` | Correct a mis-geolocated user |

Share payloads are built server-side so web and native word the invite
identically and every channel carries its own `?c=` tag without each client
remembering to add one.

`/r/:code/:slug` sits at the root because it is a link a person sends over
WhatsApp — putting `/api/v1` in the middle of it would be absurd. It is also the
path to register as the universal/app link. Unknown and revoked codes redirect to
the homepage rather than 404ing, so the endpoint can't be used to probe which
codes exist.

## Attribution flow

The referral row is written **inside the existing signup transaction**, for both
email signup and social login. Written outside it, a referral row could survive a
signup that rolled back, or vanish while the account it describes persists.

Circuit detection runs **after** that transaction commits, fire-and-forget. It
reads and writes rows belonging to users far outside the one signing up, and no
scoring bug should ever be able to stop an account being created. The ledger's
unique constraints make re-running it safe.

A code reaches signup by one of three routes: explicitly in the signup body,
parked on the guest session beforehand, or from the `kk_ref` cookie the redirect
sets (read by the web client, which passes it back in the body).

## What was left out

- **Deferred deep linking.** Click a link on the web, install from the App Store,
  and the code is lost — the app has no way to recover it without device
  fingerprinting, which isn't worth the privacy cost. The mitigation is the
  "Have an invite code?" field on the signup screen. This matters more than it
  looks: a lost code doesn't just cost one attribution, it makes that user a root
  instead of a child, so **everyone they later refer is invisible to the original
  referrer forever**, and any circuit that would have closed through that branch
  never fires. Worth making that field prominent rather than tucking it away.
- **Most anti-fraud.** No review queue, no score-velocity detection, no device
  clustering, no disposable-email blocklist. All of those were sized for
  defending prize money and there are no prizes. What remains is the free
  structural stuff: a self-referral `CHECK`, `UNIQUE(referred_user_id)`, per-IP
  signup caps, rate limits, and a manual admin void. **Attaching a prize is the
  trigger to revisit** — in that order: reinstate the points hold until email
  verification, add a review queue, add cluster detection.
- **Rescoring after a country correction.** Past referrals keep the country they
  snapshotted, so points already awarded stand. Re-deriving them means walking
  every referral the user is party to in both directions plus every circuit that
  touched them — real work, and it should be deliberate rather than a side effect
  of fixing a typo.
- **Unwinding circuits on void.** Voiding a referral clears its direct award but
  leaves circuit points that may now be unearned, for the same reason.
- **The marketing video.** `REFERRAL_VIDEO_URL` ships pointing at
  `https://kinkane.com/about` and is still returned by the API, but the supplied
  copy has no slot for it, so no message currently links it.
- **An end date for the competition.** The launch copy says "80 Days" but
  `REFERRAL_CAMPAIGN_ENDS_AT` only switches the *words* — it does not stop
  scoring, close a season, or freeze the leaderboard. Points keep accruing to
  season 1 after it passes. If "80 days" is meant to bound the contest rather
  than describe it, that is a separate piece of work and `season_id` is where it
  would land.

## How it was verified

38 new unit tests. 26 across the two pure rule functions — `scoreDirectReferral` and
`findCircuitEarners` — covering the cases that decide points and are invisible
from a happy path: unknown continents on both sides, an identical-but-unplaceable
country, a circuit closing five levels down, an ancestor sitting below the last
departure, and an unknown continent that must not be able to stand in for
"leaving". Plus link-shape tests: accent stripping (`René` → `rene`, not `ren`),
non-Latin names falling back to `friend`, no trailing hyphens after truncation,
and the code alphabet excluding `I/L/O/U`.

The remaining 12 pin the invite copy to its exact supplied strings — including
that the curly apostrophes stay curly and the deliberate mid-paragraph line
break in the evergreen body survives — plus the campaign switch in all three
states (window open, window closed, unconfigured). Copy held verbatim breaks
silently otherwise: a well-meaning edit to an em dash changes what every invited
reader sees and nothing else in the system notices.

Both variants were also rendered end to end and read by eye — From line,
subject, SMS text, plain-text body, and the HTML (one CTA href, the arrow
intact, the line break preserved as `<br>`, no unsubscribe footer).

`npx tsc --noEmit` is clean. The three failures in `subscription-pricing.test.ts`
are pre-existing on `main` and unrelated to this change.

**The migration has not been run.** `DATABASE_URL` points at the live Render
instance, so applying it is a deliberate step: `npm run db:migrate && npm run
db:init` (the second seeds `countries` — without it every referral scores zero).
