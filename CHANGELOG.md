# Changelog


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

