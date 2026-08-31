# Referral funnel, verified crediting, and the journey map

Brings the referral API up to what the "Around the World" design actually needs:
an invite funnel a user can act on, points that only count once a referred
reader proves their address is real, and the network and campaign data behind
the journey map, the globe, and the analytics screen.

## What changed

**Points are earned at verification, not at signup.** `attributeSignup` still
writes the referral edge inside the signup transaction — attribution is the
durable fact and must not be able to fail an account creation — but it no longer
writes points. `referralsService.creditVerifiedSignup` does that, called from
`verifyEmail`. Google sign-ups arrive already verified and are credited
immediately after attribution, so nothing is delayed for them.

**A `Sent / Successful / Pending` funnel.** New `referral_invites` table, one row
per emailed invite or per share sheet the user opened. `/referrals/me/stats`
gained `sent`, `successful` and `pending`.

**Cities and coordinates.** `users` gained `city`, `city_lat`, `city_lng` and
`city_source`; `referrals` gained `referrer_city` and `redeemer_city`. The geo
service now reads city and location out of the MaxMind result when the database
in use carries them.

**Three new endpoints**, plus one changed response:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/referrals/me/network` | user | The journey map and globe: every node below the caller, plus the summary the screens display |
| `GET /api/v1/referrals/analytics` | **public** | Campaign totals, eight weekly buckets, top referrers by signups |
| `GET /api/v1/referrals/map` | **public** | Anonymous city pins for the globe's "others" layer |
| `POST /api/v1/referrals/shares` | user | Records a WhatsApp / SMS / copy share, feeding `sent` |

## The non-obvious decisions

**The three funnel figures deliberately do not reconcile.** The design shows
`Sent 18 / Successful 12 / Pending 6`, which reads as `18 = 12 + 6`. It isn't.
`sent` counts what this user initiated; `successful` and `pending` count people
who arrived, and people arrive via forwarded messages and links pasted into
group chats that no send of ours ever recorded. Making the three add up would
mean either discarding those signups or inventing sends that never happened.
Both response and OpenAPI say this explicitly so a client doesn't "fix" it.

**Existing points were grandfathered rather than re-derived.** The migration
backfills `credited_at = signed_up_at` for every pre-existing referral. Applying
the verification gate retroactively would have voided points for referees who
never verified — correct by the new rule, and a visible score drop for users who
did nothing wrong. Everyone keeps what they had; the gate applies forward.

**`redactName` is in the service, not the route.** Every path that could surface
a referred reader's name goes through one function, so there is exactly one
place a full name could leak from. `/me/network` shows first name plus last
initial and a city — a narrowing of the earlier position that referees should
not be visible to their referrer at all. That position was deliberate and is
recorded in the code; it was reversed knowingly, because a journey map of
anonymous dots is not the feature that was designed. Full names remain
admin-only.

**City never touches scoring.** Points are decided by country, which comes from
a coarser but far more reliable lookup. City exists so the map reads as a
journey — "Accra → Paris → Calcutta" rather than "GH → FR → IN" — and so the
globe has somewhere to put a pin. A competition decided by which city an ISP
thinks you are near would be a competition decided by ISP routing.

**Cities cannot be backfilled, so they are filled on next login.** City is
derived from the request IP, and the only trace of an old signup's IP is a
one-way hash. Every account predating this change has `city = null` for ever
unless something re-resolves it. `geoService.backfillCityInBackground` runs on
login, writes only when `city IS NULL`, and re-checks that condition in the
`UPDATE` so two concurrent logins can't have the second overwrite the first with
a different airport. Once set, city is as immutable as country: a user who
travels must not migrate across the map mid-campaign.

**A CDN country header and a MaxMind city are only combined when they agree.**
The header is the more trustworthy source for country, but only MaxMind returns
a city. If the header says GH and MaxMind says Paris, the two disagree about
where the request came from, and the city is the half we trust less — the
country is kept and the city dropped, rather than placing a Ghanaian reader in
France.

**Top referrers rank by signups; the leaderboard ranks by points.** These are
genuinely different orderings — three cross-continent referrals outscore fifteen
domestic ones — so `/analytics` computes its own list rather than reusing
`referralScoringService.leaderboard`. Both figures come back in the response so
a client can show either without a second call.

**Charts return every week, including empty ones.** A week with no activity
produces no row, and a chart that omits it draws a straight line across the gap,
which reads as steady rather than as quiet. `densify` emits all eight buckets.
Weeks are Monday-based UTC on both sides, matching Postgres's `date_trunc`, or
the first bucket would be half-width and always look like a slump.

**The longest chain is walked upward from the deepest node**, not searched
downward from the caller — the deepest node is by definition the end of a
longest path, and every node stores its parent. Ties break on earliest signup so
the strip a user sees is stable between refreshes instead of flipping between
two equally deep branches.

## Fixed on review, before merge

Three defects found reviewing this branch against itself:

**Linking a Google account to an unverified one stranded the referral.** Both
social branches returned `emailVerified: true` to the client without ever
writing it, so the account stayed unverified in the database while the app
believed otherwise — and never showed the OTP screen again. Harmless while
points were awarded at signup; once they moved to verification it meant the
referrer's points could never be written, silently and permanently. Both
branches now persist the flag and credit, via `markVerifiedAndCreditReferral`.
The check on the already-linked path is normally a no-op; it exists to catch
accounts linked before this was true.

**Voiding a direct referral promoted its grandchildren a generation.**
`networkFor` inferred the caller's depth from the shallowest surviving
descendant, which is correct only while no row between them has been voided.
Void A→B with B→C surviving and C came back as a *direct* referral of A. The
caller's depth is now read from their own referral row through a shared
`depthOf`, which is where `treeFor` already got it. This also removed a
`Math.min(...spread)` over the whole row set.

**Weekly chart buckets could silently read zero.** `date_trunc('week', …)` on a
`timestamptz` truncates in the session time zone, which nothing in the
connection setup pins, while the JS side keyed on UTC Mondays. On a deployment
whose Postgres defaults to a regional zone, every bucket lookup would miss and
both charts would render eight zero bars beside healthy non-zero totals. The
queries now pin the truncation with an explicit `at time zone 'UTC'`.

## Explicitly out of scope

- **The referral link and code format are unchanged.** The design's
  `kinkane.app/join?ref=CODE` and `JACKIE-K80` were considered and rejected: only
  `/r/CODE/name-slug` is click-tracked, and codes are random precisely so they
  can't be enumerated to expose the user list. The design changes, not the server.
- **"Credited within 24 hours" is not implemented and will not be.** Credit is
  immediate on verification. The rules card needs rewording, not a delay.
- **Voiding a referral still leaves circuit awards standing.** Unchanged, and
  still a known limitation — see `referralScoringService.voidReferral`.
- **An unverified intermediary still occupies its position in a circuit path.**
  `ancestor_path` is fixed at insert and filtering it by verification would
  change what a path means. Left alone deliberately.
- **The points and leaderboard mechanic still has no screen** in any of the four
  designed frames. That is a design gap, not an API one.

## Verified

`npx tsc --noEmit` clean. 475 tests pass, including 19 covering `redactName`,
`buildLongestChain`, `densify` and the degree arithmetic — the pure functions
here that fail silently rather than throwing. The 3 failures in
`subscription-pricing.test.ts` are pre-existing and unrelated (Stripe
configuration).

Not yet exercised against a live database: the migration and the new queries
have not been run, and `db:migrate` plus a pass over the Postman collection are
the next step.
