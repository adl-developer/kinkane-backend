# Reader type taglines — mobile client brief

**Audience:** whoever shows a reader type anywhere in the Kinkané apps: the
onboarding and retake result screens, Profile and settings, and the "Readers
like you loved" rail.
**Status:** committed 2026-09-26 on `feat/reader-type-taglines`.
Not yet merged or deployed to staging.

This document is self-contained. Field-by-field contracts live in the OpenAPI
spec at `GET /openapi.json` (Swagger UI on the same host). **Where this document
and the spec disagree, the spec is correct**, since it is generated from the
running code.

---

## 1. What changed

Each of the eight reader types now has a one-line tagline, and every endpoint
that tells you a reader type now sends its tagline with it:

> **The Echo Collector**
> Thoughtful; stories linger and accompany you on your journey.

The new field is `readerTypeTagline`, and it always sits next to `readerType`.

**This change only adds fields.** Nothing was renamed or removed, and
`readerType` is still a plain string, so a build that ignores the new field
keeps working.

## 2. The rule for `readerTypeTagline`

It is a `string` or `null`, and **it is `null` exactly when `readerType` is
`null`**. There is never a type without a tagline, and never a tagline without
a type.

A reader has no type when they haven't finished onboarding, or when the
profile couldn't be inferred. Both happen in production. When that's the case,
**hide the tagline line.** Don't show a placeholder or a generic fallback. The
server deliberately doesn't invent one.

## 3. Where it appears

| Method | Path | Auth | What the tagline describes |
| --- | --- | --- | --- |
| `POST` | `/api/v1/guest-sessions/{id}/selections` | none | The type inferred from a guest's onboarding picks |
| `POST` | `/api/v1/recommendations/selections` | Bearer, Plus | The type just inferred from a quiz retake |
| `GET` | `/api/v1/user/settings` | Bearer | The reader's current type |
| `GET` | `/api/v1/explore/reader-type` | none — Bearer optional | The cohort the rail was built from (see §5) |

### Onboarding and quiz retake results

The two picks endpoints return the same shape. `POST /guest-sessions/{id}/selections`
ends onboarding, and `POST /recommendations/selections` ends a signed-in retake.
Both already returned the newly inferred
`readerType`. Now its tagline comes with it, so the result screen can show both
without another request. This is the first place a new reader meets their type:

```json
{
  "readerType": "The Open Door",
  "readerTypeTagline": "You're open to the world but discerning about what stays.",
  "books": [ { "id": 48213, "title": "Girl, Woman, Other", "coverUrl": "https://…" } ]
}
```

If inference fails, `readerType` is `null`. On a retake the reader keeps the type
they had before, but this response doesn't tell you what that was. To show it,
read `GET /user/settings`. A guest whose inference fails signs up with no type.

**The spec was wrong about the guest endpoint until this change.** It documented
the response as `{ "ok": true }`, but the endpoint has been returning
`{ readerType, books }` all along. It now documents the real shape.

### Profile and settings

```json
{
  "settings": {
    "name": "Ada",
    "photoUrl": null,
    "shelfVisibility": "friends",
    "readerType": "The Echo Collector",
    "readerTypeTagline": "Thoughtful; stories linger and accompany you on your journey."
  }
}
```

`name`, `photoUrl` and `readerType` were already in this response. Until now the
spec only documented `shelfVisibility`, and it now lists all of them.

## 4. Don't hard-code the copy

**Always show the tagline the server sends. Don't keep a copy of it in the
app.** The copy belongs to the product team and will be edited. With the server
as the only source, an edit ships without an app release, and every screen
agrees with every other screen.

The table in §7 is there for design QA, not for the app to use as data.

## 5. The "Readers like you loved" rail now says which cohort it read

`GET /explore/reader-type` has two new fields, `readerType` and
`readerTypeTagline`:

```json
{
  "readerType": "The Seeker",
  "readerTypeTagline": "You read to learn, and learn to provide meaning to life.",
  "books": [ … ],
  "pagination": { "total": 137, "limit": 20, "offset": 0, "hasMore": true }
}
```

`readerType` is the cohort the rail was **actually built from**:

- if you sent the `readerType` parameter, it's that value;
- otherwise it's the signed-in reader's own type.

**Use this field for the rail heading**, not a reader type you stored somewhere
else. The stored value can be wrong in two cases:

- **You previewed another cohort**, or **the visitor is signed out**. The
  reader's own type isn't the group the rail shows, or there is no reader to
  read a type from.
- **The reader retook the quiz** on another screen and got a new type. The
  rail follows the retake straight away, but a type the app cached earlier
  doesn't.

Suggested heading, in second person as the house voice requires:

> **Readers like you loved**
> Based on your "The Seeker" profile: *You read to learn, and learn to provide
> meaning to life.*

When a reader previews a cohort that isn't theirs, "your … profile" isn't true.
Switch to something like **"The Seeker readers loved"**.

The rail's empty-state rule hasn't changed. `readerType` still comes back when
`books` is empty, but you should **still hide the section when `books` is
empty**. A heading and tagline over a blank carousel is the state the rail brief
tells you to avoid. `readerType` is `null` only when there was no cohort to
read at all.

## 6. Layout notes

- **The lengths vary a lot.** The shortest tagline is about 40 characters. The
  Book-ist's is about 100 and will wrap to two or three lines on a phone.
  Design for the long one, and don't truncate. The tagline is a single sentence
  and reads wrongly when cut off.
- **Show it as plain text, exactly as sent.** Some taglines contain double
  quotes (`"So many books, so little time": …`), a straight apostrophe
  (`You're`) and an ellipsis character (`…`). These are part of the copy, so
  don't strip or escape them.
- The taglines are already in second person, so they can sit directly under
  the type name without any rewording.

## 7. The eight taglines, for QA

Copy comes from the product sheet "Kinkané App Reader Types", with three fixes:
"emphatic" was corrected to "empathic", stray whitespace was trimmed, and The
Open Door was given the full stop that every other tagline has.

| Reader type | Tagline |
| --- | --- |
| The Open Door | You're open to the world but discerning about what stays. |
| The Seeker | You read to learn, and learn to provide meaning to life. |
| The Book-ist | "So many books, so little time": tackled with your determined organisation and unfailing optimism. |
| The Story Circler | You don't just read … you start conversations with your kin. |
| The Mirror Within | Heart-driven, you seek empathic connection. |
| The Echo Collector | Thoughtful; stories linger and accompany you on your journey. |
| The High Summiter | Life is a challenge, to be questioned and won. |
| The Cloud Illusionist | You seek the effortless to counter the challenge. |

The sheet lists the second type as "The Seeker or The Committed Seeker". The
API calls it **"The Seeker"**, and that's the value you'll receive.

## 8. Not covered yet

- **The first onboarding request** (`POST /recommendations`) returns no reader
  type. There are no picks yet to infer one from. The type arrives with the
  picks step in §3.
- **Another reader's profile** (`GET /users/{userId}`) doesn't return a reader
  type, even though the spec's `UserProfile` schema lists one. Don't build
  against that field. If the design shows someone else's type, ask. It's a
  small server change.
