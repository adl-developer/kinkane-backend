# A delivery phone number, collected at checkout and kept on the profile

## What changed

The checkout form and the account screen in the web eCommerce designs both
collect a phone number, and there was nowhere to put it.

- `users.phone` and `orders.contact_phone`, both nullable, both stored E.164.
- `POST /api/v1/cart/checkout` accepts `contactPhone`.
- `PATCH /api/v1/user/settings/profile` accepts `phone` (`null` clears it).
- `GET /api/v1/auth/me` and the order endpoints return it.
- The number now rides to Gardners as the SMS tracking contact.

## Why

The client had a field with nowhere to send it. More to the point, the Gardners
dropship format has always carried a `TRACKINGSMS` field and we were sending it
empty on every single order — so the courier had no number to text about a
delivery. That is the difference between a redelivery and a returned parcel.

## Non-obvious decisions

**A bare national number is rejected, not guessed at.** `020 123 4567` could be
completed using the shipping country, and doing so would produce a plausible,
well-formed, undialable number. Refusing it costs the buyer one correction;
accepting it costs a delivery. `00` is converted to `+` because that is a real
international prefix people type, not a guess about what they meant.

**`contactPhone` is honoured for signed-in buyers; `contactEmail` still is not.**
The email identifies the account, and letting a request body override it would
turn checkout into a way to send someone else's receipt anywhere. A phone number
carries no such authority — it is where the courier calls — and someone shipping
a gift should be able to give the recipient's number without editing their own
profile. A signed-in buyer who sends none falls back to their stored number.

**The number is snapshotted onto the order.** Editing a profile number later
must not retroactively change the contact on a parcel that already shipped.

**No phone-number library.** Validation is shape-only: E.164, 8–15 digits. Real
validation needs libphonenumber and a data file that ages, and neither "this
number is unallocated" nor "this country code does not match the shipping
address" is worth refusing a sale over. A typo'd but well-formed number is a
delivery problem, not a checkout problem.

## Explicitly out of scope

**Backfilling `users.phone`** from anywhere. Every existing row is null; the
column fills as people check out or edit their profile.

**Writing a checkout number back to the profile.** A buyer who types the
recipient's number for a gift would find their own profile quietly changed.

## Verification

`npx tsc --noEmit` clean. `src/__tests__/phone.test.ts` covers normalisation —
including the formats in the checkout designs verbatim, the `00` prefix,
national-number rejection, and the E.164 length bounds against the `varchar(32)`
columns they feed, so the schema cannot accept something the insert then
truncates.
