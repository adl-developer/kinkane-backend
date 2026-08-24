# Web eCommerce designs vs. the server — gap plan

Status: **P0, P1 and P2 complete** (2026-08-24). Two items deferred by decision:
P1's reviews (source undecided) and the admin order-action endpoints (the screens
are read-only). See `changelog/2026-08-24-admin-console.md`. Audited against the
"Kinkané Web eCommerce" Figma (file `NPKXRFHdV9POc2NW88Ndsw`, last touched
2026-08-20), all four pages: Web (26 frames), Admin (10), Mobile (14),
Email Template.

This document covers only the gaps where **something is designed and the server
cannot serve it**. Screens missing from the designs themselves (order tracking,
search results, author pages, password reset, the whole mobile checkout and
account half) are a design-side list and are recorded at the end for reference
rather than planned here.

## Reading the Figma

The file has copy/export disabled for viewers, so the REST API returns
`403 File not exportable` on every content endpoint and `/v1/files/.../nodes`
is useless. `/meta` still works and confirms the file. Everything below was
read through the Figma web app with a browser session; the layers panel gives
the frame inventory and each screen has to be zoomed individually. If this
audit needs repeating, either get export enabled on the file or budget for
the same manual pass.

## What this is

Six pieces, in dependency order. The first three block launching the shop
against these designs at all; the fourth and fifth are content surfaces the
storefront links to but cannot fill; the sixth is an admin console that does
not exist in any form.

1. **Phone number** — collected and displayed, stored nowhere.
2. **Shop filters and sort** — the Filters modal asks for four things `GET /books` has never supported.
3. **First-order discount** — a promise printed on every page with no mechanism behind it.
4. **Reviews** — a PDP tab with no data source, and a data source that is not what the design shows.
5. **Contact Us** — a footer link on every page with no endpoint.
6. **Admin console** — ten screens against two static-token routers.

## Decisions needed before building

1. ~~**Is the 15% off automatic on first order, or a code the customer types?**~~
   **Decided 2026-08-24: automatic**, keyed on the buyer's email. A second
   promotion will need the codes table this skipped; `discount_reason` is the
   seam it hangs off. **The checkout design still needs a discount line** — it
   currently shows Subtotal, Shipping and Total with nowhere for the reduction
   to appear.
2. **What feeds the Reviews tab — reader reviews or editorial press quotes?**
   The design shows press quotes ("The New York Times, Roxane Gay",
   "Oprah's Book Club") which have no source anywhere in the system. Reader
   ratings *do* exist. These are different features; see part 4.
3. **What does "Active" mean on the Customers screen?** Ordered recently,
   signed in recently, or not blacklisted? The dashboard repeats the same
   figure, so it needs one definition.
4. **Where do failed orders appear in the admin Orders tabs?** The design
   offers Processing / Shipped / Delivered. `supplier_rejected` is precisely
   the order an operator needs to find and it belongs to none of them.

---

# P0 — the checkout cannot ship without these

## 1. Phone number — **done**

Checkout collects a phone number and the Profile screen displays it under
Personal Information. `users` has no phone column
(`src/db/schema/users.ts`) and `orders` carries `contactEmail` only
(`src/db/schema/commerce.ts`).

- Add `phone` to `users` and `contact_phone` to `orders`, plus the migration.
- Accept and validate on `POST /cart/checkout` and `PATCH /users/profile`.
  E.164, and note the design's own examples are Ghanaian and Indian numbers —
  do not assume a UK format.
- Return it from `GET /users/me` and the order endpoints.
- Check whether the Gardners dropship record wants it. `src/services/gardners-dropship/`
  sends no phone today; a delivery contact number is the kind of thing a
  courier integration asks for later and is cheaper to thread through now.

## 2. Shop filters and sort — **done except price sort**

The Filters modal offers Title, Author, **ISBN**, Genre, **Price Range
(0–100)**, **Publication Year (1937–2024)** and a **Sort By** dropdown.
`listSchema` in `src/controllers/books.controller.ts` supports
`q, genre, availability, productForm, publishingStatus, publisher, sort,
limit, offset, dedupe, shoppable, cursor` — the four emphasised above do not
exist.

- **ISBN** — exact match first, prefix as a fallback. `idx_books_isbn13`
  already exists.
- **Publication year** — range over `publication_date`. `idx_books_publication_date`
  already exists.
- **Price range** — lives in `gardners_stock.rrp_gbp`, not on `books`. The
  join only exists on the `shoppable=true` path, so gate the filter to that
  path and return a validation error otherwise rather than silently ignoring it.
- **Currency.** The filter values arrive in the customer's presentment currency
  and the column is GBP pence. Convert the bounds through the same FX rate
  pricing uses; comparing raw numbers will quietly mis-filter every non-GBP
  visitor.
- **Sort By** — the design shows "Title (A–Z)" selected. Today `sort` is
  `asc|desc` with no field, and is ignored entirely whenever `q` is present
  because relevance ranking takes over (`books.service.ts`, the branch
  commented "relevance ranking takes priority and sort is ignored"). Decide
  whether an explicit `sortBy` overrides relevance or is ignored the same way,
  and say so in the route comment — this is the kind of silent no-op that gets
  filed as a bug later.
- **Extend `countCacheKey`.** The list total is cached for 30 minutes keyed on
  the filter fields only. Any new filter that is not in that key will serve
  another filter's count.

## 3. First-order discount — **done**

"15% OFF YOUR FIRST ORDER" runs as a permanent banner on every frame of the
site. There is no discount anywhere in the pricing path, on `orders`, or in the
Stripe session builder.

- Add `discount_minor`, `discount_gbp_pence` and a reason or code reference to
  `orders`. Both currency sides, like every other money column on that table.
- Eligibility: "first order" keys on **email, not user id**. Guests check out
  without an account, so a user-id check is trivially bypassed by not signing in.
- Apply it in `POST /cart/price` so the basket shows the reduction before
  checkout, and as a Stripe discount on the session — `src/lib/stripe.ts`
  already pulls in the coupon types.
- **Abuse guard.** The admin Reports screen mocks up this exact complaint:
  *"Created multiple accounts to abuse the 15% first-order discount. Confirmed
  duplicate email patterns."* The design is telling us the failure mode. At
  minimum: normalise the email before the eligibility check (strip dots and
  `+tags` on the domains that treat them as aliases), and record which email a
  discount was granted against so the pattern is queryable later.
- Banner text is editable from the admin Settings screen (P2.11) while the
  discount rate lives in code. Whoever builds both should decide whether the
  rate moves into the same settings row, or accept that the banner can lie.

---

# P1 — content surfaces the storefront links to

## 4. Reviews — **deferred** (decision 2 unresolved)

The PDP has a four-tab strip: About | Excerpt | **Reviews** | You May Also Like.
Excerpts are already served (`book_excerpts`, surfaced through
`books.service.ts`). Reviews are not.

**What the ONIX feed does not give us.** The Gardners sample carries 834
`<TextType>06</TextType>` blocks, which is the ONIX code for a review quote —
but every single one is the string "Select Guide Rating" wrapped around a
`<ReviewRating>` of 1–5. No text, no `<SourceTitle>`, no `<TextAuthor>`. It is
Gardners' internal buying-guide score, the distribution skews low (316 ones and
285 twos against 20 fives), and rendering it as customer stars would be
actively misleading. **Do not use it.**

**What we do have.** `community.posts` carries a `rating` of 1–5 with body text
per book (`src/db/schema/community.ts`), and `GET /community/books/:bookId/posts`
already lists them. The whole community router sits behind `requireAuth`
(`src/routes/community.routes.ts`), so a shop visitor sees none of it.

- Expose book reviews publicly (or under `optionalAuth`), respecting shelf
  visibility and any blocking rules.
- Aggregate rating and count on the book detail response, cached with the
  existing `BOOK_DETAIL_TTL`.
- The press quotes in the design are editorial content with no source in the
  system. Either add a small admin-entered table for them, or drop them from
  the design and show reader reviews. **Decision 2.**

## 5. Contact Us — **done**

Designed on the Mobile page, linked in the footer of every web frame, no
endpoint exists.

- `POST /v1/contact` — name, email, subject, message.
- Rate-limit it the way `guestOrderLimiter` limits guest order lookups, plus a
  honeypot field. An unauthenticated endpoint that sends mail is a spam relay
  if it is not.
- Deliver to a support inbox through the existing email infrastructure. Storing
  the messages is optional; not storing them means no history when someone asks
  what a customer said.

---

# P2 — the admin console (~2–2.5 weeks)

Nothing of this exists. `app.ts` mounts exactly two admin routers,
`/admin/gardners/dropship` and `/admin/referrals`, both behind
`requireAdminToken` — a single shared static token, no accounts, no roles, no
audit trail.

The screens are read-only to a degree worth noticing: across ten frames the
only mutating controls are **Blacklist User**, **Dismiss**, the two banner
toggles with **Save Changes**, and **Mark all read / Clear** on notifications.
There is no refund button, no status editor, no order-detail page. Build to
that, not to a general-purpose admin.

## 6. Admin identity — **done**

Email and password, "Sign In", nothing else. No 2FA, no SSO, no
forgot-password flow is designed. Worth flagging that this console can
blacklist users and export the entire customer list, so the thinnest possible
auth is a deliberate risk rather than an oversight. Sessions, roles, and
retiring `requireAdminToken` (or narrowing it to machine callers) belong here.

## 7. Orders — **done** (read-only, as designed)

Status tabs `All / Processing / Shipped / Delivered` with counts, a search box,
an Export button, and rows that expand to reveal Items and Ship To. That is the
whole screen — no actions.

- The work is bucket mapping. `order_status` has eleven values
  (`src/db/schema/commerce.ts`); the design shows three tabs.
  `Shipped` = `dispatched`, `Delivered` = `delivered`, `Processing` = `paid`
  + `submitted_to_supplier` + `acknowledged`. `payment_failed`, `expired`,
  `supplier_rejected` and `refunded` map to nothing — **decision 4**.
- `GET /orders` already buckets for the customer-facing tabs via
  `status=in_progress|delivered|closed`; reuse that vocabulary rather than
  inventing a second one.
- Search covers order reference and customer name/email.

## 8. Customers — **done**

Three stat cards (Total 12, Active 10 with "2 inactive", Total spent $1840), a
searchable table of Customer / Email / Country / Orders / Total Spent / Last
Order / Status, an Export button, and a red **Blacklist** action per row.

- `users.country_code` already exists, so the Country column is free.
- Orders count and total spent are aggregates over `orders` — cheap now,
  worth a rollup later.
- Blacklisting needs a state on `users` that does not exist, and a decision
  about what it actually does: block sign-in, block ordering, hide their
  community posts, or all three.
- "Active" is **decision 3**.

## 9. Reports — **done**

Cards headed `R003 · Pending` / `R004 · Resolved`, showing reported user and
reporter with names and emails, the complaint text, and **Blacklist User** /
**Dismiss**.

`user_reports` (`src/db/schema/reports.ts`) has `reporterId`, `reportedUserId`,
`postId`, `reason`, `createdAt` — and no status, no reference, no resolver.

- Add a status enum (pending / resolved / dismissed), a display reference,
  `resolvedBy` and `resolvedAt`.
- List endpoint joining both users' names and emails.
- The two actions, sharing the blacklist implementation from part 8.

## 10. Dashboard — **done** (live aggregates; rollup deferred)

Four stat cards — Total Orders (all time), Revenue (all time), Customers (with
an active count), Processing ("need fulfilment") — plus a Recent Orders table
with an **Export all** button.

`idx_order_items_bestseller` helps the product-level aggregates; the rest is
plain aggregation over `orders` and `users`. At current volumes live queries
are fine, but the "all time" framing means these only get slower — plan for a
nightly rollup before it becomes a problem.

## 11. Settings — **done**

One card, **Announcement Banners**: the red "WE SHIP WORLDWIDE!" strip and the
charcoal "15% OFF YOUR FIRST ORDER" strip, each with an on/off toggle and an
editable text field, above a Save Changes button. The subtitle reads "Changes
apply to the storefront instantly."

- A settings or banners table, admin write endpoint, and — the piece that is
  easy to miss — **a public endpoint the storefront reads them from**. Without
  that the toggle controls nothing.
- "Instantly" means either no cache or a very short one. Say which.

## 12. Admin notification feed — **done** (order_delivered not yet emitted)

The bell appears in every admin header with an unread badge. The panel shows
"3 new", **Mark all read**, **Clear**, and a list of events with relative
timestamps. Four event types, none of which anything emits today:

- New report filed
- New order received
- New customer registered
- Order marked delivered

This is separate from the user-facing `notifications` table and needs its own
emitters wired into the order, signup and report paths.

## 13. Exports and badge counts — **done**

- CSV export on three screens: Dashboard ("Export all"), Orders, Customers.
  Stream them; decide a row cap and whether the export respects the active
  filter or dumps everything (the dashboard button says "all", the others do not).
- Sidebar badges — Orders `1`, Reports `3`. One counts endpoint, not a list
  call per badge.

---

# Effort summary

| Phase | Item | Estimate |
| --- | --- | --- |
| P0 | 1. Phone number | 0.5d |
| P0 | 2. Shop filters and sort | 2d |
| P0 | 3. First-order discount | 2–3d |
| P1 | 4. Reviews | 1–3d |
| P1 | 5. Contact Us | 0.5d |
| P2 | 6. Admin identity | 3d |
| P2 | 7. Orders | 2d |
| P2 | 8. Customers | 3d |
| P2 | 9. Reports | 3d |
| P2 | 10. Dashboard | 3d |
| P2 | 11. Settings | 1d |
| P2 | 12. Admin notifications | 2d |
| P2 | 13. Exports and badges | 1.5d |

Suggested order: 1 → 2 → 3, with 5 dropped in alongside whenever convenient;
4 once decision 2 lands; then the admin block as its own project behind 6.

---

# Appendix — design-side gaps, for the designer

Not server work. Recorded here so the list exists in one place.

**Screens the flows point at that do not exist:** order tracking (the
confirmation screen has a "Track My Order" button), order detail or receipt
(My Account lists orders with no way in), search results (there is a search
icon on every frame), author page (the PDP author is drawn as a link),
forgot/reset password, email verification, 404 and error states, and the
out-of-stock treatment that `shop-integration.md` instructs clients to build.

**Gaps inside screens that do exist:** checkout has no promo code field despite
the banner, no tax line, no shipping method choice, no billing address, no
sign-in option for returning customers, and no payment step drawn at all. The
PDP has no quantity selector and no stock indicator.

**Mobile page** is missing Checkout, My Account, Login, Create Account, Our
Story, Filters and order confirmation — the entire buying and account half of
the responsive site.

**Create Account** carries the designer's own note: *"Google Auth missing. Make
sure it's added."* The server side of that already exists (`POST /auth/social`).
