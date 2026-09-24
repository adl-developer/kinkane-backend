# "Readers like you loved" — mobile client brief

**Audience:** whoever builds the "Readers like you loved" rail in the Kinkané
apps.
**Status:** committed 2026-09-15 on `feat/configurable-recommendation-weights`.
Not yet merged or deployed to staging.

This document is self-contained. Field-by-field contracts live in the OpenAPI
spec at `GET /openapi.json` (Swagger UI on the same host). **Where this document
and the spec disagree, the spec is correct** — it is generated from the running
code.

---

## 1. What the rail is

Every reader is assigned one of eight **reader types** when they finish the
onboarding quiz — "The Open Door", "The Seeker", and so on. It is not fixed for
life: retaking the quiz re-infers it and can move the reader to another type, so
don't cache it past the point where a retake could have happened (see §10). This
endpoint answers one question:

> Of the other people who share your reader type, which books did they
> respond well to?

It is a popularity vote inside a group, and it is deliberately **not** the same
thing as `GET /explore/personalized`. That one measures the whole catalogue
against your own taste profile. This one ignores your profile entirely and
reports what a group of people like you actually read. The two will often
disagree, and both are right.

## 2. The endpoint

```
GET /api/v1/explore/reader-type?limit=20&offset=0
Authorization: Bearer <access token>
```

**No sign-in required, and no Kinkané Plus.** The likes behind the rail come
from a Plus feature, but this is the rail that shows someone what Kinkané readers
are reading before they have an account, so gating it would defeat its purpose.

**Send a token anyway whenever you have one.** The rail personalises itself when
it knows who is asking:

| | Signed in | Signed out |
| --- | --- | --- |
| Which cohort | Your own reader type, or `readerType` if you send it | `readerType` only — **omit it and you get an empty list** |
| Your own likes | Don't count toward the ranking | n/a |
| Your shelf and swiped-away books | Filtered out | **Not** filtered — you may see books the reader already owns |

A signed-out visitor therefore sees *more* books than a signed-in member of the
same cohort, not fewer. If this rail appears on any screen a signed-in reader can
reach, send the token — otherwise they will be shown books already on their
shelf.

| Param | Range | Default | Notes |
| --- | --- | --- | --- |
| `limit` | 1–50 | 20 | Items per page. |
| `offset` | 0+ | 0 | Rows to skip. Ordering is stable, so paging will not repeat or drop books. |
| `readerType` | one of the eight | *your own* | Reads a different group. See §7. |

## 3. The response

```json
{
  "books": [
    {
      "id": 43935,
      "title": "Culpability",
      "subtitle": null,
      "coverUrl": "https://…/covers/9780593651032.jpg",
      "isbn13": "9780593651032",
      "productForm": "BB",
      "productFormLabel": "Hardback or cased book",
      "publicationDate": "2024-01-02",
      "contributors": [
        { "role": "A01", "personName": "Bruce Holsinger", "sequenceNumber": 1 }
      ],
      "genres": [],
      "excerpt": null
    }
  ],
  "pagination": { "total": 137, "limit": 20, "offset": 0, "hasMore": true }
}
```

Books are ordered most-supported first. The book object is the same shape every
list and search endpoint returns, with one exception — see §5.

## 4. The empty state is the normal state, and it is not an error

**`200` with `"books": []` comes back in two situations:**

1. The reader has no reader type yet — they have not finished onboarding, or
   the profile could not be inferred. Both happen in production. **A signed-out
   visitor who did not send `readerType` is this case too**, and it is the normal
   signed-out state.
2. Nobody else shares their reader type. On a small user base this is common,
   and on a brand-new install it is the default.

Neither returns `404`, and neither should be treated as a failure. **Hide the
section.** Both cases mean the same thing to the app — there is no rail to draw
— and giving them separate handling produces two code paths to the same
outcome.

Do not show an empty rail with a heading above it, and do not show a spinner
that never resolves.

## 5. These rows carry no price

This is the one way the rail differs from `/explore/trending`,
`/explore/bestsellers` and `/explore/personalized`, which all arrive priced.

**There is no `unitPriceMinor`, `compareAtMinor`, `currency` or `inStock` on
these books, and there is no `currency` parameter to send.** The rail was
specified as a discovery carousel with no Add button, so it carries no shop
fields. Books the shop cannot sell are still filtered out, so nothing on the
rail is unbuyable — tapping through to the book page will always work.

If the design changes and the rail needs an Add button, that is a small server
change, not a redesign. Ask, and it will carry prices like the others.

## 6. What "loved" actually means

Worth knowing, because it determines what you can honestly title the section.
A book counts when someone in the group has done **any** of:

- liked it,
- marked it as read, or
- named it as a book they enjoyed, in onboarding or a later quiz retake.

A person counts **once** per book however many of those apply. **Your own shelf
never counts** toward a book's score — "readers like you" means other readers,
so a book only you have liked can never appear here.

Two further rules worth knowing:

- **Editions are collapsed.** A title appears once, not three times for its
  paperback, hardback and ebook. Its ranking reflects everyone who backed any
  edition of it.
- **Books already on the reader's shelf, and books they have swiped away, are
  excluded** — including other editions of them.

### Suggested wording

The mock's heading works as-is:

> **Readers like you loved**
> Based on your "The Open Door" profile

Keep it in second person, per house voice. Avoid anything that promises a
number — "12 readers like you loved this" is not something this endpoint can
support. See §9.

## 7. `readerType` — previewing a group that is not yours

Passing `readerType` reads a different group instead of your own:

```
GET /api/v1/explore/reader-type?readerType=The%20Seeker
```

Send the exact value, URL-encoded. The eight are:

```
The Open Door        The Seeker           The Book-ist        The Story Circler
The Mirror Within    The Echo Collector   The High Summiter   The Cloud Illusionist
```

This matters more than it looks. It is how the rail can be built and demoed
before there are real groups to read, it is the only way a reader who has not
finished onboarding can see anything here — and **signed out it is the only way
to select a cohort at all**, since there is no account to read a reader type
from.

**An unrecognised value is a `400`, deliberately.** A typo returning an empty
list would be indistinguishable from a group nobody else is in, and you would
spend an afternoon on it.

## 8. Errors

| Code | When |
| --- | --- |
| `400` | `limit`/`offset` out of range, or an unrecognised `readerType`. |
| `500` | Genuine server fault — retry is reasonable. |

There is no `401` — the endpoint is public, so a missing or expired token is
treated as signed out rather than rejected. There is no `403` (not Plus-gated)
and no `404` (see §4).

**Watch that first one.** An expired token does not fail here, it silently
downgrades to signed-out behaviour. If the rail starts showing a reader books
they already own, check the token before you check the server.

## 9. One request, in return

**Do not ask for liker counts, names or avatars on this rail without raising it
first.**

The rail is built by reading the shelves of everyone in a reader type,
regardless of whether those shelves are set to public, friends-only or private.
That is only acceptable because the response is anonymous — it returns books and
nothing else, not even the count that drives the ordering.

The moment a count or a face is attached, a shelf someone set to private
becomes reconstructable: in a group with one other member, "1 reader loved this"
*is* that person's private shelf. If the design needs social proof here, say so
early — it can be built, but the server has to start filtering on shelf
visibility first, and that is a different piece of work.

## 10. Two things to expect in testing

**It will look empty on a fresh environment, and that is correct.** The rail
needs at least two readers sharing a reader type, one of whom has shelf
activity. Seeded and demo databases often have neither. Use `readerType` (§7)
against a group you have seeded rather than concluding the endpoint is broken.

**Retaking the quiz can move a reader between groups.** Reader type is assigned
at signup and re-inferred whenever a signed-in reader saves their picks from a
retake, so the rail — and the profile name in the heading above it, which comes
from the same column — can both change after a retake. If your test account's
rail suddenly holds different books, check whether you retook the quiz on it.
When inference fails the reader keeps the type they had.

## 11. Endpoint summary

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/v1/explore/reader-type` | none — Bearer optional | `{ books, pagination }` — books only, no prices |
