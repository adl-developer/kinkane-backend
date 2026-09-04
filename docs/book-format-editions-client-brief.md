# Book format labels & sibling editions — client integration brief

**Audience:** whoever renders book cards and the book detail screen in the
Kinkané apps.
**Status:** live now, no flag. Every field below is already in the responses
you're calling today — nothing to opt into.

This document is self-contained. Everything you need to integrate is here.

---

## 1. What is changing, and why

Every book carries a `productForm` field — a raw two-character ONIX code
(`BC`, `BB`, `AJ`, …) describing its format. It's always been in the
response, but nothing ever translated it, so the only way to show "Paperback"
instead of "BC" was to hardcode a lookup table client-side against a list of
~180 possible codes.

Two additions fix that:

1. **`productFormLabel`** — the human-readable version of `productForm`,
   computed server-side. Render this, not `productForm`.
2. **`otherEditions`** — on the book detail response only, the other formats
   of that same title (hardback/paperback/e-book/etc.), so you can build an
   "Also available as" format switcher without a second search.

---

## 2. `productFormLabel`

Present everywhere a book object appears:

| Endpoint | Shape |
| --- | --- |
| `GET /api/v1/books`, `GET /api/v2/books` | book list |
| `GET /api/v1/books/search` | suggestions |
| `GET /api/v1/books/:id` | book detail |
| `GET /api/v1/books/:id/similar` | book list |
| `GET /api/v1/explore/trending`, `GET /api/v1/explore/personalized` | book list |
| `GET /api/v1/user-books` | user's bookshelf |

```json
{
  "id": 48213,
  "title": "Half of a Yellow Sun",
  "productForm": "BC",
  "productFormLabel": "Paperback or softback book"
}
```

- **Always render `productFormLabel`, never `productForm`.** The code is
  still there for anything you already built against it, but it's not
  display text.
- **`productFormLabel` can be `null`** — either `productForm` itself is
  `null` (missing data), or it's a code outside the standard ONIX list. Both
  are rare but real. Fall back to hiding the format line, not to showing the
  raw code.
- The label is looked up server-side from the full ONIX List 150 codelist —
  you don't need your own copy of it, and you don't need to update anything
  client-side when a new code shows up in the catalogue.

---

## 3. `otherEditions`

Only on `GET /api/v1/books/:id` (`BookDetail`). Not on list/search/feed
responses — computing it is a real query, so it only runs for the one book
you're actually looking at.

```json
{
  "id": 48213,
  "title": "Half of a Yellow Sun",
  "productForm": "BC",
  "productFormLabel": "Paperback or softback book",
  "otherEditions": [
    {
      "id": 51900,
      "isbn13": "9780007200283",
      "productForm": "BB",
      "productFormLabel": "Hardback or cased book",
      "coverUrl": "https://covers.kinkane.app/...",
      "publicationDate": "2006-08-03"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | The sibling's own book id. Fetch its detail page the normal way — `otherEditions` doesn't inline the rest of that book's data. |
| `isbn13` | The sibling's own ISBN. Different from this book's — every format has its own ISBN. |
| `productForm` / `productFormLabel` | The sibling's format, same meaning as above. This is normally the whole reason to show the entry. |
| `coverUrl` | Can be `null`. Fall back to a placeholder, same as anywhere else in the catalogue. |
| `publicationDate` | Can be `null`. Useful for ordering entries if you show more than one. |

**An empty array is normal, not an error.** Most books have exactly one
edition in the catalogue — Gardners' feed doesn't publish an explicit "these
ISBNs are the same work" link, so this is server-side matching on title +
publisher + a shared author/contributor, not a supplier-asserted fact. Treat
it as "we found some," not "this book definitely has no other formats."

**What it will not do:**
- It won't surface an edition credited only to a generic byline — "Various",
  "Anonymous", "Unknown" and similar don't count as a shared author, on
  purpose. Otherwise every anthology in the catalogue credited to "Various
  Authors" would appear to be "another edition of" every other one.
- It can occasionally miss a real sibling (if the title text drifted
  slightly between editions) or, in principle, group two different books
  that happen to share both an exact title and a named contributor. Treat it
  as a helpful cross-link, not a guaranteed-correct "same work" graph.

---

## 4. Suggested UI

- **Book card / list row:** show `productFormLabel` as a small tag near the
  price, the way you'd show a stock badge. Skip it entirely when `null`.
- **Book detail page:** if `otherEditions` is non-empty, render a row of
  format chips ("Paperback · Hardback · E-book") above or below the price,
  each linking to that sibling's own detail page (`GET
  /api/v1/books/:id` with its `id`). If it's empty, show nothing — don't
  render an empty "Other formats" section header.

---

## 5. Checklist

- [ ] Every place you currently render `productForm` renders
      `productFormLabel` instead.
- [ ] `productFormLabel: null` falls back to hiding the format line, not to
      showing the raw code.
- [ ] Book detail page reads `otherEditions` and renders format chips when
      it's non-empty.
- [ ] Empty `otherEditions` renders nothing — not an empty section, not an
      error state.
- [ ] Tapping a sibling in `otherEditions` navigates using its own `id`, not
      the current book's.
