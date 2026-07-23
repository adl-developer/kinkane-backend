# Changelog


## 2026-07-23

### Features

* add an in-app notifications feed ([d9f1d66](https://adl.github.com/adl-developer/kinkane-backend/commit/d9f1d66defbae7b6da2e6eed1eaacc9e33fc331a)) — [details](changelog/2026-07-23-notifications-feed.md)
* stop search suggestions from showing the same book twice ([10cfe28](https://adl.github.com/adl-developer/kinkane-backend/commit/10cfe2821aa954d890df5930c7544994f19f08fd)) — [details](changelog/2026-07-23-dedupe-search-results.md)
* allow partial feelings/genres in recommendation requests and avoid repeat picks ([25458b4](https://adl.github.com/adl-developer/kinkane-backend/commit/25458b44f67e62ed0782fa4181838597dadfbdf8))
* add profile details and trial status to the account info endpoint ([5459c80](https://adl.github.com/adl-developer/kinkane-backend/commit/5459c8080297ba74baaceabb454c74af190c5a13)) — [details](changelog/2026-07-23-stop-like-comment-emails.md)

### Bug Fixes

* nest plan status fields back under subscription in account info response ([3c712f4](https://adl.github.com/adl-developer/kinkane-backend/commit/3c712f49c6719cead996559a5ea9875d0cfeb7a3)) — [details](changelog/2026-07-23-subscription-trial-audit-trail.md)


## 2026-07-21

### Features

* verify email with a 6-digit code instead of a link ([71e5392](https://adl.github.com/adl-developer/kinkane-backend/commit/71e539286452b24467a74edfc73f10e44a8bf2a8)) — [details](changelog/2026-07-21-email-verification-otp.md)
* make new users' shelves public by default ([00b355f](https://adl.github.com/adl-developer/kinkane-backend/commit/00b355ff190507157c7a42a16114c2e5afbc44d0)) — [details](changelog/2026-07-21-shelf-visibility-default-public.md)


## 2026-07-18

### Bug Fixes

* run db:migrate against a database missing required extensions ([1a99ecf](https://adl.github.com/adl-developer/kinkane-backend/commit/1a99ecff9af97f5d82b36031147b7dd3835961ba))
* detect SSL requirement from the connection string, not NODE_ENV ([62148fe](https://adl.github.com/adl-developer/kinkane-backend/commit/62148fe10aeaeab305d2a1f1226190345fe17370))


## 2026-07-16

### Features

* add is_removed/removed_at columns so withdrawn books aren't deleted ([7b1229b](https://adl.github.com/adl-developer/kinkane-backend/commit/7b1229bc1d15423f72ace269f22c4433e4645461)) — [details](changelog/2026-07-16-books-soft-delete.md)


## 2026-07-15

### Features

* make Google Books cover fallback a true last resort ([5c829d4](https://adl.github.com/adl-developer/kinkane-backend/commit/5c829d44e2efbfcdd3ab593b2e68dceffaf6930f)) — [details](changelog/2026-07-15-gardners-cover-checked-column.md)


## 2026-07-14

### Features

* add database tables for the Gardners wholesaler feed pipeline ([f42cc51](https://adl.github.com/adl-developer/kinkane-backend/commit/f42cc51aeeb13e728911e3e7a2da0409f9869b7f)) — [details](changelog/2026-07-14-gardners-feed-tables.md)

### Bug Fixes

* stop showing duplicate book titles in recommendations and feeds ([9ffec59](https://adl.github.com/adl-developer/kinkane-backend/commit/9ffec595a48753e665bb0ac8860974203112d1c0)) — [details](changelog/2026-07-14-dedupe-book-titles.md)


## 2026-07-13

### Features

* let users report other users ([b12544f](https://adl.github.com/adl-developer/kinkane-backend/commit/b12544f93a793142a3c63cd0bd7537e1ac560419)) — [details](changelog/2026-07-13-report-user.md)


## 2026-07-10

### Features

* send push notifications for likes, comments, follows, and recommendations ([f92a75f](https://adl.github.com/adl-developer/kinkane-backend/commit/f92a75f30ac8c5a7088e67729ca8ca89ae6904ab))

### Bug Fixes

* prevent duplicate recommendation emails and reduce unnecessary database queries on likes and comments ([ebabf60](https://adl.github.com/adl-developer/kinkane-backend/commit/ebabf60090f40fc9e5a78794b6df0be4c267fa70))


## 2026-07-09

### Features

* show a reader's shelf status on the book detail page ([62d0f7a](https://adl.github.com/adl-developer/kinkane-backend/commit/62d0f7a7789bd7743b4d4af4de0ee22a23ed0f68))
* let users fetch their saved reading preferences ([2891f4a](https://adl.github.com/adl-developer/kinkane-backend/commit/2891f4ae1c88b330c3f68e2a5b3971d89565f66d))


## 2026-07-07

### Bug Fixes

* let users unfollow someone even after the request was accepted ([983618a](https://adl.github.com/adl-developer/kinkane-backend/commit/983618a64b37361762c4b181804485c7cd75165f))
* stop the recommendation fallback from failing on a retired Gemini model ([d875c53](https://adl.github.com/adl-developer/kinkane-backend/commit/d875c5301d402384976550d0c61088144226f6f9))


## 2026-07-01

### Features

* let users manage notification preferences and receive personalised book recommendations by email ([2942995](https://adl.github.com/adl-developer/kinkane-backend/commit/29429951e86a981514c2e37e5a65af04f0080d5f))


## 2026-06-30

### Features

* let users like books independently of their reading status ([e9a1b02](https://adl.github.com/adl-developer/kinkane-backend/commit/e9a1b0205c801e2616a8068f4c6cf43974d6db9c))

### Bug Fixes

* stop preference refresh from hanging when Gemini is slow ([03f3b4d](https://adl.github.com/adl-developer/kinkane-backend/commit/03f3b4d5468e0e7f56db884f765146a152a8cb8e))
* make AI-generated explanations and reader-type results consistent ([0c3d299](https://adl.github.com/adl-developer/kinkane-backend/commit/0c3d299982c0fb2a9ced5e4b51bb7aa2f2f6c6bc))


## 2026-06-22

### Features

* add subscription upgrade stub endpoint ([dcbe75f](https://adl.github.com/adl-developer/kinkane-backend/commit/dcbe75f2e9357b4c5e5d8c2f1730c17b8c135126))
* add follower/following list endpoints with pagination ([74e4208](https://adl.github.com/adl-developer/kinkane-backend/commit/74e4208a60494fc02259ce4e6e9b51fdbdee1848))
* add email verification flow ([7283bfe](https://adl.github.com/adl-developer/kinkane-backend/commit/7283bfef99784afdaa7d523265ae4f534f37cb70))
* add explore discovery feed and recommendation refresh ([3923c8b](https://adl.github.com/adl-developer/kinkane-backend/commit/3923c8b26c271834696a4e99e103825c4f57e215))


## 2026-06-16

### Features

* filter recommendations by similarity threshold before ranking ([fce929f](https://adl.github.com/adl-developer/kinkane-backend/commit/fce929fdded645e0920a3ee60d6abd1dfa79a28f))
* infer and persist reader type during onboarding ([b9faf67](https://adl.github.com/adl-developer/kinkane-backend/commit/b9faf676b47ded9c12e98ecd8de2cb87d05a955d))


## 2026-06-02

### Features

* add date-added sort options to user books list ([d856160](https://adl.github.com/adl-developer/kinkane-backend/commit/d856160d9b99dfa3ce3dd923216f7dc01fe37612))
* add update profile endpoint and expand get settings response ([5a4ee6d](https://adl.github.com/adl-developer/kinkane-backend/commit/5a4ee6d8f376345ac1d38f7e46ed461bb0ca81e2))


## 2026-06-01

### Features

* user profile, account management, and settings endpoints ([b781bb4](https://adl.github.com/adl-developer/kinkane-backend/commit/b781bb4b18801a8dd09721a2b706f0a986829738))
* add author filter to books list endpoint ([f66f1c6](https://adl.github.com/adl-developer/kinkane-backend/commit/f66f1c6ca7edb67b7fd0b420bc51ab1c7df7f9f5))


## 2026-05-29

### Features

* user books reading list with notes, status filtering, and sort ([9c6173c](https://adl.github.com/adl-developer/kinkane-backend/commit/9c6173c130b09b41b36675a28c48184e25c49962))


## 2026-05-27

### Features

* transactional email system with SendGrid, BullMQ queue, and password reset ([06d31ff](https://adl.github.com/adl-developer/kinkane-backend/commit/06d31ffcb804d72f6629e57989973913fda0c9f3))

