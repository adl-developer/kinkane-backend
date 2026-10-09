# Usernames, and @-mentioning people anywhere they write

## What changed

Every reader now has a **username**, a public `@handle` that is unique and lowercase, like `@ama_reads`. People can be **@-mentioned** in anything another reader writes:

- reviews (community posts)
- comments on reviews
- group descriptions
- the description on a group's current read
- group discussion comments and replies
- shelf notes

The mentioned person is notified. They can see everywhere they have been mentioned, and they can switch mention notifications off.

**Usernames**

- **At signup.** `POST /auth/signup` and `POST /auth/social` take an optional `username`.
  - A malformed or reserved name is a 400 under `error.username`, like any other field on the form.
  - A blank value (`""` or spaces) counts as not provided. Form libraries often send `""` for an untouched optional field.
  - A taken one is a 409 with `code: USERNAME_TAKEN`, and no account is created.
  - If no username is sent, one is generated from the display name: "José Mensah" becomes `josemensah`, or `josemensah42` if that is taken.
- **Existing accounts.** Every non-guest account got a generated username in migration 0074.
- **Checking a name.** `GET /users/username-available?username=` works signed out, for the signup screen. Signed in, it answers for the caller: their own current name reads as available, and they're told if they're inside the change cooldown.
- **Changing it.** `PATCH /user/settings/username`, once every 30 days. The first change after signup is free whenever it happens. The name given up is **held for its old owner for 30 days**, so nobody else can grab it straight away.
- **Undoing a change.** Taking back a name you're still holding is always allowed, even inside the 30 days. It doesn't restart the cooldown, and the name you step off is only held until the original hold would have run out, so flipping between two names can't keep both reserved for ever. Without this exception the hold could never be used, because it lasts exactly as long as the cooldown.
- **Looking someone up.** `GET /users/by-username/:username` returns the same profile as `GET /users/:userId`.
- **Everywhere else.** Every user object the app already receives now carries the username: post authors, commenters, followers, group owners and members, search results, `/auth/me`, login and signup responses.

**Mentions**

- **Writing.** Clients send plain text with `@username` in it, as typed. Nothing changes in any request.
- **Reading.** Every read that returns mentionable text returns it with the current usernames, plus a positions array the client uses to make each handle tappable:
  - `mentions` next to a post or comment `body`
  - `descriptionMentions` next to a group or shelf description
  - `noteMentions` next to a shelf note
  - `reviewMentions` and `noteMentions` on a friend's book detail
- **Typeahead.** `GET /community/mention-suggestions?q=&context=` returns up to 10 people. The people already in that conversation come first, then friends, then everyone else.
- **"Mentioned me" list.** `GET /user/mentions` lists everywhere you've been mentioned, newest first.
- **Notifications.** A new `mention` type in the notifications feed, with push. It has its own `mentions` toggle in notification preferences.
- **Search.** Community search also matches on username, and a query starting with `@` searches usernames only.

## Why

The community needed a way to address a specific person, and a display name can't do that: it isn't unique, and it changes. A handle that is unique and stable enough to type is the usual answer. Mentioning it needs to reach the person, not just look like a link.

## How mentions are stored

A mention is typed as `@ama_reads`, but it refers to a person, not a string. If it were stored as typed, renaming `ama_reads` to `ama.reads` would break every old mention, or quietly point them at whoever claims `ama_reads` next.

So when text is saved, every handle that names a real account is replaced by a token holding the account id, `@{{u:123}}`. On every read, each token is rendered as that account's username at that moment. This is the same idea as the `{{name}}` token in recommendation explanations.

- **Renames** cost nothing.
- **A deleted account's mention** reads `@deleted` and is not linked.
- **Clients never see a token.** What they're shown is exactly what they can send back on an edit, so editing round-trips.
- **A token typed by hand** is broken on the way in, so it can't pose as a mention that nobody was notified about.

The **`mentions` table** records one row per person per piece of text. It exists for what the text can't answer cheaply: who to notify, whether they have been, and the "mentioned me" list.

- It has **one foreign-key column per kind of text** rather than a polymorphic `(type, id)` pair. Every source then cleans up after itself through `ON DELETE CASCADE`, which matters because there are a dozen delete paths and several of them are cascades nobody calls code for: a deleted account, a deleted group, a deleted top-level comment taking its replies. A `CHECK` keeps exactly one of those columns set.
- An edit **syncs** the rows, and each person is notified at most once per piece of text however often it's edited:
  - Someone newly mentioned gets a row, still to be notified.
  - Someone no longer mentioned who was never told (the text was private) loses the row, and the waiting notification with it.
  - Someone no longer mentioned who *was* told keeps the row, marked `removed_at`, and drops out of their "mentioned me" list. Deleting it would let an edit that takes a handle out and puts it back notify the person again each time, which is a way to spam someone.
  - Someone mentioned again after a removal has the same row revived, and isn't told again.

## Who gets notified, and when

Anyone can be mentioned anywhere, but a notification is only useful if the person can open what they were mentioned in. For each mentioned person:

- **They can see the text** (a public post, a public group, a group they're in, a public note). They're notified with a 140-character excerpt.
- **The text is in a private group they aren't in.** They're notified that they were mentioned there, with the group name but **no excerpt and no comment ids**. A group's name is public; its discussion is not, and a notification must not become a way to read a private group from outside.
- **The text is private to its author** (a private post, a comment under one, a private note). Nothing is sent yet. If the author later makes it public, the held notifications go out then.

Other rules:

- **No double ping.** Someone mentioned in a new comment on their own post isn't sent a mention notification as well, because "new comment on your post" already covers the same words. This only applies when that comment notification was actually sent. A mention added by editing a comment notifies the owner as a mention (edits send no comment notification), and so does a new comment if the owner has comment notifications switched off.
- **Self-mentions** are linked like any other but never stored or notified.
- **Mentions switched off.** The notification is marked handled without sending. Otherwise, turning them back on would release a backlog.
- **Sent once.** Each notification is claimed with an `UPDATE … WHERE notified_at IS NULL`, so two concurrent dispatches can't both send it.
- **Cheap when there's nothing to do.** A new text with no mentions skips all of this. An edit with none clears any rows its earlier version left and sends nothing.
- **Rechecked on read.** The "mentioned me" list re-checks visibility every time. An entry whose text you can no longer see keeps its place with `restricted: true` and no excerpt, so pages don't shift.

## Data model

Migration **0073** (generated):

- `users.username varchar(20)`, nullable, with a unique index. Stored lowercase, so the plain index is also case-insensitive.
- `users.username_changed_at timestamptz`, for the cooldown. It's null until the first chosen change.
- `username_holds(username pk, user_id, expires_at)` for released names. Expired rows are inert, and the next release of the same name overwrites them in place.
- `mentions`: one FK per source (`post_id`, `comment_id`, `group_id`, `group_book_id`, `group_comment_id`, `user_book_id`) plus `mentioned_user_id`, `author_id`, `notified_at`, `removed_at` and `created_at`. A `CHECK` requires exactly one source. There is a unique index per `(source, mentioned_user_id)` and a `(mentioned_user_id, created_at)` index for the list.
- `notification_preferences.mentions boolean default true`.

Migration **0074** (hand-written): the backfill.

- It uses the same recipe as `usernameBaseFromName` in `src/lib/username.ts`: strip accents, keep a–z and 0–9, cap at 15 characters, and fall back to `reader` when too little is left or the result is reserved. Then it appends 2, 3, … until the name is free.
- The database has no `unaccent` extension, so accents are mapped with `translate()` over the Latin-1 and Latin Extended letters. The two recipes agree on every Latin name.
- Guests are skipped.

## Validation rules

- **Usernames:** 3–20 characters of `a-z 0-9 _ .`, not starting or ending with `.`, and no `..`.
  - ASCII only, deliberately. The database ctype is C, so Postgres would compare accented letters byte-wise and `lower()` wouldn't fold them.
  - The dot rules keep "thanks @ama." parseable as a mention of `ama`.
  - Input is trimmed, one leading `@` is dropped, and the result is lowercased before any check.
- **Reserved names:** roles and words a mention or URL could mean something by, such as `admin`, `support`, `everyone` and `deleted`. Also any name containing `kinkane`.
- **Guests have no username.** The web shop creates about ten guest accounts for every real signup, all named "Guest". Giving each one a `guest4821` would fill the namespace with names nobody chose.
- **Typed mentions:** an `@` counts only at a word boundary, so email addresses are ignored. Trailing dots belong to the sentence, not the name.
- **Per-text limit:** at most 20 distinct people are linked per piece of text. Further handles stay as plain text.
- **Rate limits:** the availability check allows 120 requests per 15 minutes per user, or per IP when signed out.

## Non-obvious decisions

- **Separate field names for multi-field objects.** A friend's book detail has two mentionable texts, so it gets `reviewMentions` and `noteMentions` rather than one ambiguous `mentions`. Groups and shelf entries use `descriptionMentions` for the same reason: the object is a group, not a piece of text.
- **Generated usernames at signup are race-safe.** Each candidate is tried in its own savepoint. Two people called Ama signing up in the same instant both see `ama` free; the loser's attempt rolls back on its own and moves to the next candidate instead of aborting the signup.
- **The typeahead with nothing typed** shows only the conversation and your friends. A list of alphabetical strangers isn't a suggestion.
- **The typeahead never reveals a private group's members.** A `context` the caller can't see is silently ignored rather than refused.
- **Public shelf notes are cached** for two minutes. The cache now holds the stored text and rendering happens after it, so a rename shows up straight away instead of when the cached copy expires.
- **Moderators see usernames.** The admin report queue renders mentions in reported group comments, so moderators don't read raw tokens.

## What's explicitly out of scope (for now)

- **Search by mentioned username.** Group search's generated `search_vector` indexes the stored description, tokens included, so searching for a mentioned person's username won't find the group. It's harmless and rarely wanted.
- **Mentions in private notes** are stored and rendered for their owner, but nobody else can read them, so nobody is notified unless the note is made public.
- **Old usernames.** A held name doesn't resolve to its old owner: `/users/by-username/<old>` is a 404 during the hold.
- **Mention emails.** Like comments and likes, mentions send push and in-app notifications only, never email.

## Testing done

- **Unit tests:**
  - `username.test.ts` covers normalization, the format and reserved rules, generation from names in several scripts, candidate suffixes and the cooldown date.
  - `mention-text.test.ts` covers parsing at word and sentence boundaries, emails, tokenizing, neutralizing hand-typed tokens, the 20-person cap, rendering, renames, deleted accounts, UTF-16 offsets after emoji, and the edit round trip.
- **Integration tests:** `mentions.integration.test.ts` runs against a real Postgres (31 tests).
  - Signup: a chosen username, a taken username (409, no account), a generated one.
  - Changes: the hold, the cooldown, the "current" answer.
  - Mentions: token storage and rendering through a rename; notify once, not again on an edit; removal on edit; self-mention; held-then-released for a private post and its comments; restricted for a non-member of a private group, and full for a member.
  - Behaviour: preference off; concurrent dispatch sends once; post owner not double-pinged; FK cleanup on comment delete; `@deleted`; unknown handles left as text.
  - Typeahead: ranking, `_` as a literal, empty-query scope, no self or guests.
  - Fixes from code review: a mention edited out and back in never notifies twice; a mention added by a comment edit reaches the post owner, as does one in a new comment when the owner has comment notifications off; undoing a rename inside the cooldown; a private shelf note's mention held until it's made public; a group description mention; no bookkeeping for a new text with no mentions.
- **No raw tokens anywhere:** `mention-rendering.integration.test.ts` puts a mention into every kind of text that can hold one, then calls every signed-in GET under community, users, groups, books, shelf, settings, explore and saved books, taken from the live route table, and fails if any response contains a stored token. Endpoints added later are swept automatically. It was checked by deliberately breaking the single-post endpoint, which it caught and named.
- **Existing suites:** the friend-request integration suite passes against the same database, and the full unit suite passes.
- **Migrations:** 0000–0074 applied from scratch to a C-locale Postgres 16. The backfill was run against sample names covering accents, duplicates, CJK, short, reserved, branded, guest, long, and a real `amaowusu2` colliding with a generated suffix.
- **HTTP smoke test:** the real Express app against that database, covering every new endpoint and the changed signup, settings, post, search, notifications and `/auth/me` responses.
