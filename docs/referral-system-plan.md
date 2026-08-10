# Referral system & "Around the World" competition — plan

Status: **implemented** on `feat/referral-competition`, 2026-08-10. Decisions
confirmed 2026-08-09. See `changelog/2026-08-10-referral-competition.md` for what
actually shipped; two things diverged from this document during the build:

- **`referrals.status` is `active | voided`**, not `signed_up | qualified |
  rejected`. Once points counted at signup (decision 3), the intermediate
  "qualified" state had nothing left to represent.
- **A guest session gets its referral code via its own endpoint**
  (`POST /v1/guest-sessions/:id/referral`) rather than a field on session
  creation. Guest sessions are created several layers down inside the
  recommendations flow, and threading competition plumbing through those call
  sites would have put it in the middle of an unrelated feature.

## What this is

Any signed-up user can invite a friend with a personal link, share it over SMS,
WhatsApp or email, and the server records who referred whom. Referrals score
points based on **where in the world the code is redeemed**, and the full
referral tree is walked to detect an "around the world" circuit. The system has
two halves that should be built and reasoned about separately:

1. **Attribution** — codes, links, redemption, the referral forest. Mechanical.
2. **Scoring** — geography, points, circuits, leaderboard. This is where the
   genuinely hard problems are, and all of them are geography problems.

## Definitions

- **Redeemed** — a referral code is redeemed when someone receives it and uses
  it to *create an account*. Redemption is the moment attribution is written.
- **Circuit / "around the world"** — a downward path through your referral tree
  that starts on your continent, leaves it, and ends back on it.
- **Habitable continents** — Africa, Europe, Asia, North America, South America,
  Australia & Oceania. Antarctica is excluded from the competition.

## Decisions

1. **Open to every authenticated user, in all three subscription states.** Not
   gated behind Kinkané Plus. Every account is `tier=plus, status=trialing` for
   its first 90 days anyway (`auth.service.ts` signup), so a paid gate would
   either exclude almost nobody or almost everybody depending on the launch
   window. Referral is a growth feature, not a paid perk.

   | State | Shape in `user_subscriptions` | Can refer? |
   |---|---|---|
   | **Trialing** | `tier=plus, status=trialing`, no `stripe_subscription_id` | Yes |
   | **Paid** | `tier=plus`, `stripe_subscription_id` present | Yes |
   | **Gated** (trial expired, never paid) | `tier=free, status=expired` | Yes |

   **The gated case needs an explicit carve-out.** A gated user is read-only by
   design — the membership rule is "gate writes, not reads", and `requirePlus`
   returns 402 on mutation. But generating a referral link *is* a write (it
   inserts a `referral_codes` row), and so is sending an email invite. Both must
   be deliberately exempted, or gated users get a 402 on the invite screen. The
   referral routes must never be mounted behind `requirePlus`, and any future
   blanket write-gate must skip them.

2. **Links never expire and never stop working.** There is no eligibility to
   lose.

3. **Points are awarded at signup, on redemption — not on email verification.**
   Redemption *is* the scoring event. The referral row and its ledger entries
   are written together in the signup transaction, and count immediately.

   This deliberately drops the earlier "hold points until verified" design.
   That hold existed to stop disposable inboxes farming a prize; with **no
   prizes** (decision 6), it buys nothing and costs the referrer a confusing
   delay between "my friend joined" and "my score moved". If a prize is ever
   attached, this is the first decision to revisit — see the note in *Abuse
   controls*.

4. **A circuit is awarded once per user, not once per qualifying path.**
   Recommended and adopted. Per-path is unbounded: a user with a wide tree
   collects 30 points repeatedly for what is meant to read as a single
   achievement — "my referrals went around the world" — and it rewards tree
   width, which the 1/10/20 rules already pay for. Once-per-user keeps the
   circuit a milestone. Enforced by a partial unique index on the ledger.

5. **No prizes.** The leaderboard is bragging rights. This is load-bearing for
   how much anti-fraud work is justified — see *Abuse controls*.

6. **The referral message includes a marketing video link.**
   `REFERRAL_VIDEO_URL` in config, threaded through every share payload and the
   email invite template. **Placeholder for now** — ships with a default
   pointing at the marketing site, swapped for the real URL when provided. No
   code change needed to swap it; it is an env var.

## Scoring rules

Scored against the **referrer's country** vs the **redeemer's country**:

| Condition | Points |
|---|---|
| Redeemed in the **same country** | 1 |
| Redeemed in a **different country, same continent** | 10 |
| Redeemed on a **different continent** | 20 |
| **Full circuit** — a path through your tree that leaves your continent and returns | 30 |

The first three are **direct referrals only** — depth 1, "if *your code* is
redeemed". Confirmed. Only the circuit rule walks the deep tree. The rejected
alternative, every ancestor scoring on every descendant, would make early users'
scores grow without further effort and turn the leaderboard into a function of
join date.

A practical consequence worth designing the UI around: **a user's direct score is
final the moment each friend signs up, but their circuit can arrive at any time**,
from someone several levels down whom they have never met. The stats screen
should treat the circuit as a separate, asynchronous event rather than folding
it silently into a running total.

### The circuit rule, precisely

Tom is on continent **C**. Tom earns a circuit when there exists a downward path
in his referral tree

```
Tom → n₁ → n₂ → … → n_k
```

such that **continent(n_k) == C** and **at least one nᵢ on the path has
continent ≠ C**.

That is the direct formalization of the dev note: the branch either starts on a
different continent from Tom, or its referrals touch another continent along the
way (*"leaves C"*), and the end of that branch lands back on Tom's continent
(*"ends up back on Tom's continent"*).

Worked example, Tom in Ghana (Africa):

```
Tom (Africa)
├── Ama (Europe)          ← path left Africa
│   └── Lisa (Africa)     ← …and returned. Tom scores a circuit. ✅
└── Ken (Africa)
    ├── Kofi (Africa)     ← never left Africa. No circuit from this branch.
    └── Jen (Asia)
        └── Alexander (Asia)  ← left, but never returned. Not yet a circuit.
```

Note the rule is a property of a **path**, not of a subtree: Jen's branch has
left Africa, and the moment anyone under Alexander signs up from an African
country, Tom's circuit fires.

## Data model — `src/db/schema/referrals.ts`

### `referral_codes`
`id, user_id (unique), code (unique), slug, is_active, created_at, revoked_at`

Its own table rather than a column on `users`: a code can be rotated or revoked
for abuse without touching the user row, and campaign codes with a null
`user_id` fit later without a migration.

Created **lazily and idempotently** on first `GET /v1/referrals/me`.

### `referral_clicks`
`id, code_id, channel, ip_hash, user_agent, country, created_at`

Funnel numerator only, and the highest-volume table here. Hash the IP rather
than storing it; plan a rollup-and-prune job from day one.

### `referrals` — the edge table and the tree
```
id, referrer_user_id, referred_user_id UNIQUE, code_id, click_id,
status, channel, depth, root_referrer_id, ancestor_path int[],
referrer_country, redeemer_country, referrer_tier_at_referral,
signed_up_at, qualified_at, rejected_reason
status: 'signed_up' | 'qualified' | 'rejected'
```

`UNIQUE(referred_user_id)` is load-bearing: **a user is referred exactly once,
ever.** That single constraint makes the graph a forest of trees rather than an
arbitrary digraph — which is what makes circuit detection a bounded upward walk
instead of a cycle-search problem. Plus `CHECK (referrer_user_id <>
referred_user_id)`.

`ancestor_path` is the new addition the competition forces: the ordered array of
ancestor user ids from the root down to this node's parent. Because every node
has exactly one parent, this path is unique and never changes once written, so
it can be computed at insert as `parent.ancestor_path || parent.user_id`. It is
what turns circuit detection into an array read instead of a recursive CTE per
check. Cap depth at ~20 to bound both the array and the walk.

`referrer_country` / `redeemer_country` snapshot the two countries **at
redemption**, and `referrer_tier_at_referral` the referrer's subscription state.
Snapshots, not joins: users move, subscriptions convert, and a live join would
silently rewrite the scores of past referrals every time someone travels.

### `referral_points` — the ledger
```
id, user_id, referral_id (null for circuit awards), kind, points,
state, season_id, awarded_at, voided_at, void_reason
kind: 'same_country' | 'same_continent' | 'cross_continent' | 'full_circuit'
state: 'counted' | 'voided'
```

Append-only, never mutated in place except to void. Scores are a `SUM` over this
table, never a counter on `users`. That is deliberate even without prizes: every
point stays traceable to the referral that produced it, and a bad referral can
be reversed without recomputing anyone else's total. Correction becomes
`state='voided'` rather than arithmetic.

The `pending` state is gone — points count at signup (decision 3). Reinstating a
hold later is an additive migration, not a rewrite.

**Constraints:**
- `UNIQUE(referral_id, kind)` — stops double-award on retry.
- `UNIQUE(user_id) WHERE kind = 'full_circuit'` (partial) — enforces
  once-per-user circuits (decision 4) at the database level rather than trusting
  the detection code to be called exactly once.

**`season_id`** is included from the first migration even though the competition
is currently unbounded (open question 1). It is nullable, defaults to season 1,
and costs nothing now. Adding it later means backfilling a live points table and
touching every scoring query — the asymmetry is large enough that the column is
worth carrying speculatively, which is not usually true of speculative columns.

### `countries` — reference data
`code (ISO 3166-1 alpha-2), name, continent`

Static seed. Continent is derived by join, not stored on the user, because
country→continent is stable and duplicating it invites drift.

## Geography — the hard part

**Nothing in the current schema knows where a user is.** `users` has no country
column. Every point in this competition depends on a field that does not exist
yet and that has no obviously correct source. This is the highest-risk part of
the build and deserves its own decision before implementation starts.

Candidate signals, none sufficient alone:

| Signal | Strength | Weakness |
|---|---|---|
| IP geolocation at signup | Always available, no user friction | Defeated by any VPN — and a VPN is a 20-point cheat here |
| Phone number country code | Hard to fake in volume | Not collected today; SMS verification is a whole feature |
| Device locale / store region | Cheap | Says language, not location |
| Self-declared at signup | Honest majority get it right | Trivially gamed when points are attached |

**Decided: IP geolocation at signup is the primary signal.** MaxMind GeoLite2
country DB bundled locally — no per-request API cost and no network latency
inside the signup transaction. Stored on `users.country_code`, immutable once
set, with every other available signal recorded alongside it for later analysis.

Country is **not** auto-updated on later logins. Someone travelling must not
silently rewrite their standing, and a field that drifts under the user is
impossible to reason about in a leaderboard.

**A correction path is required, not optional.** Someone in Ghana whose ISP
geolocates to the UK is a certainty at any scale, and under a points system that
is a competition dispute rather than a bug. Minimum viable version: the user's
country is visible on their own stats screen, and an admin endpoint can set it
with an audit row and trigger a rescore of that user's referrals. Self-service
country editing is deliberately *not* offered — it would make the whole
geolocation exercise pointless.

Automated defence has a ceiling. With no prizes attached, that ceiling is
acceptable; see *Abuse controls*.

### Antarctica and unknowns

Users whose country can't be determined, or resolves outside the six habitable
continents, still form valid tree edges — attribution is unaffected — but award
**zero points** and cannot satisfy the "returns to continent C" leg of a
circuit. Otherwise an unresolvable IP becomes a wildcard.

## What the tree actually contains

The tree includes **indirect referrals at every depth**, not just direct ones.
`Tom → Ama → Lisa` puts Lisa in Tom's tree at depth 2 — which is essential,
because a circuit is usually completed by someone the referrer has never met.

Both directions are cheap, thanks to `ancestor_path`:

- **Descendants, any depth** — `WHERE ancestor_path @> ARRAY[:userId]` with a GIN
  index. One containment scan, no recursive CTE.
- **Ancestors** — already materialized in the row's own `ancestor_path`.

The `depth` parameter on the admin tree endpoint truncates the *response* for
rendering; it never limits what is tracked.

Three properties that will otherwise be assumed wrongly:

1. **It is a forest, not one connected graph.** A user who signs up without a
   referral code has no `referrals` row at all — they are an isolated root,
   connected to no one. The map covers referred users only, so it will look
   sparser than total signups. That is correct, not a bug.
2. **Broken attribution severs a subtree permanently, and silently.** The
   deferred-deep-link gap (web click → App Store install → code lost) makes that
   user a root rather than a child. Everyone they go on to refer is invisible to
   the original referrer forever, and any circuit that would have completed
   through that branch never fires — with no signal that it was supposed to.
   Attribution accuracy is therefore not only a reporting concern: it decides
   who wins. This is the strongest argument for making the "Have an invite code?"
   field on signup prominent rather than tucked away.
3. **Depth is capped at ~20**, bounding `ancestor_path` and the circuit walk.
   Practically unreachable, but it is a real ceiling: a chain beyond it stops
   being recorded as connected.

## Circuit detection

Incremental, at redemption, not as a batch sweep. When user **N** redeems and
their referral row is written:

1. Read `N.ancestor_path` — every ancestor from root to parent, in order.
2. Walk it from the **nearest** ancestor upward. For each ancestor **A** with
   `continent(A) == continent(N)`, check whether any node strictly between A and
   N on the path has a different continent. If so, A has just completed a
   circuit — award, unless already awarded.
3. Stop at the root.

This is O(depth²) per redemption in the worst case, with depth capped at 20 and
the whole path already in memory — trivial next to the signup transaction it
sits beside. Run it **after** the transaction commits, idempotently, so a
scoring bug can never block account creation. The unique constraints on the
ledger make replay safe.

The continents of the path nodes are the only extra read: one `WHERE user_id =
ANY(path)` against users joined to countries.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /v1/referrals/me` | `requireAuth` **only — never `requirePlus`.** Lazily creates the code; returns link, share payloads, video URL |
| `POST /v1/referrals/me/rotate` | New code, old one revoked (abuse escape hatch) |
| `GET /v1/referrals/me/stats` | The referrer's own score: points by kind, redemption count, circuit status, countries reached |
| `GET /v1/referrals/leaderboard` | Public competition standings |
| `POST /v1/referrals/invite` | Server-sent email invite via the existing Resend pipeline |
| `GET /r/:code/:slug` | Public redirect + click capture |
| `GET /v1/admin/referrals/tree?userId=&depth=` | The map |
| `GET /v1/admin/referrals/funnel` | click → signup conversion, sliceable by country and referrer tier |
| `POST /v1/admin/referrals/:id/void` | Void a referral's points with a reason |
| `PATCH /v1/admin/users/:id/country` | Correct a mis-geolocated country; audits and rescores that user |

A "countries reached" map on the user's own stats screen is the natural UI for
this competition — it makes the 10/20/30 structure legible without explaining
the rules.

## Link shape

```
https://kinkane.com/r/{code}/{name-slug}
```

`{code}` is authoritative; `{name-slug}` is **decorative and never part of the
lookup** — resolution is `WHERE code = $1`. Deliberate, because display names
change and links already sent must keep working; names collide and carry accents
("Kinkané" is its own proof); and a unique name slug would leak the user list to
enumeration where a random code does not.

**Slug:** NFKD normalize → strip combining marks → lowercase → collapse to
`[a-z0-9]+` joined by `-` → truncate to 40 chars → fall back to `friend` when
empty (non-Latin names). Recomputed from the current name each time a link is
*rendered*; old links with stale slugs still resolve.

**Code:** 10 chars of Crockford base32 (`crypto.randomBytes`, ambiguous `I L O
U` excluded), unique index, retry on collision. Not derived from `user.id` — a
derivable code is an enumerable code.

**Channel tag:** `?c=whatsapp|sms|email|copy`, appended by the share sheet.

## Attribution flow

1. `GET /r/:code/:slug` — public, unversioned, hard rate-limited. Resolve → log
   a click → set a first-party `kk_ref` cookie (90 days, HttpOnly, SameSite=Lax)
   → 302 to the landing page or store. Unknown or revoked codes redirect
   silently to the homepage: never a 404, never confirmation a code exists.
2. The same URL registered as a **universal / app link**, so an installed app
   opens straight through with the code.
3. `guest_sessions` gains a `referral_code` column, so a code captured before
   account creation survives the existing guest→user migration.
4. `POST /v1/auth/signup` accepts an optional `referralCode` and writes the
   `referrals` row **inside the existing signup transaction**, together with its
   direct-award ledger entries (decision 3 — points count immediately). Same in
   `socialLogin` when it creates a new account.

   **Circuit detection still runs after commit**, idempotently. It reads the
   ancestor path and can touch rows well outside this user's, so keeping it out
   of the signup transaction means a scoring bug can never block account
   creation. The ledger's unique constraints make the retry safe.

**Known leak:** click on web → install from the App Store → the app has no code.
No deferred deep linking without device fingerprinting (Branch/AppsFlyer-style),
which isn't worth the privacy cost. Mitigation is an explicit *"Have an invite
code?"* field on signup, prefilled when the code arrived via deep link. Some
share-to-install traffic goes unattributed; that's the accepted trade.

## Abuse controls

**No prizes changes the sizing of this entirely.** The payoff for cheating is a
number on a leaderboard, so the rational investment is the cheap structural
controls and nothing more. Elaborate detection would cost more than the fraud it
prevents. What stays:

- `CHECK (referrer_user_id <> referred_user_id)` and never counting a referrer's
  clicks on their own link — self-dealing blocked at the schema level, free.
- `UNIQUE(referred_user_id)` — already required for the tree; also means an
  account can't be re-attributed to a second referrer.
- Per-code and per-IP-block signup caps per day. These exist for signup hygiene
  regardless of the competition.
- Hard rate limit on `/r/:code/:slug` — unauthenticated and it touches the DB.
- The admin void endpoint, as the manual backstop for anything noticed by hand.

Explicitly **not** building now: the fraud review queue, score-velocity
detection, device/account-cluster fingerprinting, and the disposable-email
blocklist. All were sized for defending prize money.

**The trigger to revisit all of this is attaching a prize** — not launch, not
scale. At that point, in this order: reinstate the email-verification hold on
points (decision 3), add the review queue, and add cluster detection. The
20-point cross-continent award is what an attacker would target, since it pays
most and a VPN plus a disposable inbox manufactures it. Worth knowing the shape
of the attack now even while choosing not to defend against it.

**Privacy:** a referrer sees counts, first names, and countries reached. Never a
referee's email, full name, or activity. The public leaderboard shows first name
and country only.

## Files this touches

- `src/db/schema/referrals.ts` (new), `src/db/schema/countries.ts` (new),
  exported from `src/db/schema/index.ts`
- `users` — add `country_code`, plus its geo-signal columns
- `src/services/referrals.service.ts` (new) — codes, resolution, attribution
- `src/services/referral-scoring.service.ts` (new) — points and circuit
  detection, deliberately separate from attribution
- `src/services/geo.service.ts` (new) — IP → country, signal capture
- `src/controllers/referrals.controller.ts`, `src/routes/referrals.routes.ts`
  (new), mounted in `src/routes/index.ts`
- `src/routes/redirect.routes.ts` (new) — `/r/:code/:slug`, mounted outside `/v1`
- `src/services/auth.service.ts` — `referralCode` through `signup` and
  `socialLogin`, written in the existing transaction
- `src/db/schema/onboarding.ts` — `referral_code` on guest sessions
- `src/emails/` — invite template carrying the video link
- `src/config/index.ts` — `REFERRAL_VIDEO_URL` (placeholder default), MaxMind
  DB path
- Drizzle migrations, country seed data, and a `changelog/` write-up

## Build order

**Phase 1 — attribution (no scoring).**
1. Schema + migration + country seed.
2. Code generation and `GET /v1/referrals/me`.
3. `/r/:code/:slug` redirect and click capture.
4. Signup attribution — direct, social, guest carry-through — with
   `ancestor_path`.

**Phase 2 — geography.**
5. `geo.service`, `users.country_code`, capture at signup. Ship this and let it
   collect data *before* points depend on it, so the accuracy of the signal is
   known rather than assumed.

**Phase 3 — scoring.**
6. Points ledger and the 1/10/20 direct awards, written in the signup
   transaction.
7. Circuit detection, post-commit.
8. Stats, leaderboard, admin void and country correction.

**Phase 4 — polish.**
9. Email invite template with the placeholder video link; share payloads.

Phase 2 before Phase 3 is the important ordering: if IP geolocation turns out to
be unreliable for the actual user base, that's a rules problem, and it is far
cheaper to discover it before the leaderboard is live than after prizes are
claimed.

## Open questions

Nothing here blocks the migration or Phase 1.

1. **When does the competition start and end?** Currently unbounded, which is a
   valid answer for a first run. The `season_id` column exists so that answer can
   change later without a painful backfill; the only thing genuinely undecided is
   what happens to standing scores if a season 2 is ever declared.
2. **Marketing video URL** — placeholder shipped, real URL swapped in via env var
   when provided. No code change.
3. **Does the leaderboard need to be public, and at what granularity?** The plan
   assumes first name plus country. Worth confirming against the privacy posture
   for shelf visibility, which already has a three-way public/friends/private
   setting users may expect to apply here too.

### Resolved

Decisions 1–6 above now cover: eligibility across all three subscription states,
link permanence, points at signup rather than on verification, once-per-user
circuits, no prizes, and the video placeholder. Direct-only scoring for the
1/10/20 awards is confirmed in *Scoring rules*; country determination and its
correction path are settled in *Geography*.
