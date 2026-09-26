# Preference history — mobile client brief

**Audience:** whoever builds the History tabs on the three preference screens
in Profile: Mood preferences, Genre preferences and What to avoid.
**Status:** committed 2026-09-26 on `feat/preference-history-by-section`.
Not yet merged or deployed to staging.

This document is self-contained. Field-by-field contracts live in the OpenAPI
spec at `GET /openapi.json` (Swagger UI on the same host). **Where this document
and the spec disagree, the spec is correct**, since it is generated from the
running code.

---

## 1. What you are building

Each preference screen has a clock icon at the top right. It opens that
section's History list: the dates the reader changed that section. Tapping a
date opens a read-only view of the section as it was on that date ("Your mood
preferences on August 10, 2026").

```
Mood preferences  ──(clock)──►  History  ──(tap a date)──►  Your mood preferences on …
Genre preferences ──(clock)──►  History  ──(tap a date)──►  Your genre preferences on …
What to avoid     ──(clock)──►  History  ──(tap a date)──►  Your deal-breaker preferences on …
```

There is one endpoint per section, and each returns only what its screens show.

## 2. The endpoints

```
GET /api/v1/user/preference-history/mood
GET /api/v1/user/preference-history/genres
GET /api/v1/user/preference-history/avoid
Authorization: Bearer <access token>
```

| Query param | Default | Notes |
| --- | --- | --- |
| `limit` | 20 | 1–100 |
| `offset` | 0 | |

**Sign-in required. Kinkané Plus is not required.** A reader only ever sees
their own history; there is no way to request anyone else's.

The list already contains everything the detail screen needs, so **tapping a
row should not make a second request**. Pass the entry you already have to the
detail screen.

If you open a detail screen from somewhere the list isn't loaded (a deep link,
say), fetch the single entry:

```
GET /api/v1/user/preference-history/{section}/{id}
```

It returns `{ section, entry }`, with the entry in the same shape as in the list.

## 3. The response

Every list response has the same envelope:

```json
{
  "section": "mood",
  "history": [ ... ],
  "pagination": { "total": 5, "limit": 20, "offset": 0, "hasMore": false }
}
```

`history` is **newest first**. Every entry has `id` and `recordedAt`, plus the
fields for its section.

### Mood

```json
{
  "id": 88,
  "recordedAt": "2026-08-10T14:00:00.000Z",
  "prompt": "I want to feel like I am in a foggy coastal town living in a lighthouse.",
  "moods": [
    { "key": "comforted", "label": "Comforted" },
    { "key": "challenged", "label": "Challenged" },
    { "key": "escaped", "label": "Escaped" }
  ]
}
```

- `prompt` is what the reader typed in the text box. It is `null` if they only
  tapped cards, so hide the text box then.
- `moods` are the cards they tapped. Use `key` to pick the icon and `label` as
  the text.
- In rare cases a mood has `"key": null`. That is extra free text beyond the
  prompt, which the design has no place for. Show it as a card with no icon, or
  leave it out. It is there so nothing the reader chose is silently lost.

### Genres

```json
{
  "id": 91,
  "recordedAt": "2026-08-10T14:00:00.000Z",
  "genres": [
    { "key": "literary fiction", "label": "Literary Fiction" },
    { "key": "poetry", "label": "Poetry" },
    { "key": "self-help", "label": "Self-Help" }
  ]
}
```

`key` is the same lowercase genre value the app sends when saving
preferences, so match icons on it.

### What to avoid

```json
{
  "id": 93,
  "recordedAt": "2026-08-10T14:00:00.000Z",
  "dealBreakers": ["Too dark or heavy", "Sad or tragic ending"],
  "categories": {
    "emotionalTone": ["too dark or heavy", "sad or tragic ending"]
  }
}
```

- `dealBreakers` is the chip list the detail screen shows: every choice across
  all categories, first letter capitalised. **A label chosen under two
  categories appears once.** The design repeats "Too dark or heavy" under both
  Emotional Tone and Content Sensitivity, and one chip is what the reader
  expects.
- `categories` is the same data grouped exactly as it was saved, in case you
  ever need the grouping. The current design doesn't.

## 4. Rendering the dates

`recordedAt` is a UTC timestamp. **Format it on the device, in the reader's
timezone**, as the design shows: "August 10, 2026". The server doesn't know
the reader's timezone, and a change made late in the evening would otherwise
show the wrong day.

Use the same formatted date in the detail title: "Your mood preferences on
August 10, 2026".

Two entries can fall on the same day if the reader saved twice. Show both
rows; they are different states.

## 5. What counts as a change

- A new entry appears only when a save **actually changes** that section.
  Saving the same genres again, or in a different order, adds nothing.
- Each section's list shows only the saves that changed that section. Changing
  only genres adds a row to Genre history and nothing to Mood history.
- **The oldest entry in every list is the reader's signup.** It appears in all
  three lists, because that is when every section was first set. A reader who
  has never edited a section therefore sees one row, not an empty screen.

Entries are written by:

| Action | Endpoint |
| --- | --- |
| Signing up (finishing onboarding) | registration |
| Saving any preference screen | `PATCH /api/v1/recommendations/refresh` |
| Retaking the quiz and picking books | `POST /api/v1/recommendations/selections` |

Entries older than two years are deleted, except each reader's most recent
one. **A list is never empty for a reader who has preferences**, but handle
an empty list anyway (a very old account from before history existed). "No
changes yet" is enough.

## 6. Paging

A reader's history is short: only real changes are recorded. `limit=100`
covers practically everyone in one request. If you page, use
`pagination.hasMore`. `total` counts only that section's entries, so it is safe
to show.

## 7. Errors

| Status | When |
| --- | --- |
| `400` | Unknown section (anything but `mood`, `genres`, `avoid`), or an invalid `limit`, `offset` or `id` |
| `401` | Missing or expired access token |
| `404` | Single-entry request for an id that doesn't exist or isn't the reader's |

## 8. Known gaps

- **Three moods, not three plus a prompt.** A reader saves 3 feelings in total,
  and a typed prompt takes one of those slots. So the mood detail will usually
  show the prompt plus two cards, where the design shows the prompt plus three.
  This changes only if the design makes the prompt a separate fourth input.
  Please don't work around it on the client.
- **New mood cards need a server change.** The server tells the prompt apart
  from the moods using the 15 mood cards in the design (Comforted through
  Suspense). If the app adds a mood card, tell the backend team. Until the
  server's list is updated, that mood comes back as `prompt` instead of a card.
- **The `…` menu on the History screen** has no behaviour defined in the
  design, and there is no endpoint behind it. If it's meant to clear history,
  that needs designing and building first.

## 9. Design issues to check with the designer

These are in the Figma file (Production page, around node `8195:14529`):

- The Mood History screen links to the **genre** detail screen, and the Genre
  History links to the **mood** one. Build it the obvious way: mood history
  opens mood detail.
- All three History screens have a "Notifications → Manage notifications" row
  under the dates. It looks copied from another screen; confirm before
  building it.

## 10. Endpoint summary

| Screen | Request |
| --- | --- |
| Mood preferences → History | `GET /api/v1/user/preference-history/mood` |
| Genre preferences → History | `GET /api/v1/user/preference-history/genres` |
| What to avoid → History | `GET /api/v1/user/preference-history/avoid` |
| Any detail screen (only when the list isn't loaded) | `GET /api/v1/user/preference-history/{section}/{id}` |

All `GET`, all need `Authorization: Bearer <access token>`, none need a body.

`GET /api/v1/user/preference-history` (no section) also exists and returns
full, unshaped snapshots of every change. It's for support and debugging; the
screens above shouldn't need it.
