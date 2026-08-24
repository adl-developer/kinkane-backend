# Changelog


## 2026-08-24

### Features

* add the staffed admin console back end ([027708a](https://adl.github.com/adl-developer/kinkane-backend/commit/027708a4bbc662c8678f8361025933d37157a5f5)) — [details](changelog/2026-08-24-admin-console.md)
* make the Contact Us form actually reach someone ([f040abd](https://adl.github.com/adl-developer/kinkane-backend/commit/f040abdd1a9ddc17f15fb2c7d4c7a734659bd1b9)) — [details](changelog/2026-08-24-contact-form.md)
* give first-time buyers their 15% off automatically at checkout ([2eaea3f](https://adl.github.com/adl-developer/kinkane-backend/commit/2eaea3f17cfa533366a0f12f71b7f42fbe2e6bb6)) — [details](changelog/2026-08-24-checkout-phone-number.md)
* let shoppers filter the shop by ISBN, price and publication year ([8efbeae](https://adl.github.com/adl-developer/kinkane-backend/commit/8efbeaea01710f9ac6b1d9b1223c8e8042a1eaf7)) — [details](changelog/2026-08-24-shop-filters.md)
* collect a delivery phone number at checkout and pass it to the courier ([272eaa4](https://adl.github.com/adl-developer/kinkane-backend/commit/272eaa45993085fde7616eb690bf5a2d3a5260cf)) — [details](changelog/2026-08-24-checkout-phone-number.md)

### Bug Fixes

* stop concurrent requests charging, shipping and discounting twice ([f79e616](https://adl.github.com/adl-developer/kinkane-backend/commit/f79e616c2924f7eaf7e1d14361efcd13c6966d13)) — [details](changelog/2026-08-24-first-order-discount.md)
* give shop listings the price they are filtered by ([4ac7a5c](https://adl.github.com/adl-developer/kinkane-backend/commit/4ac7a5c8a2cc5c40c06bf0834e710df09623c896)) — [details](changelog/2026-08-24-shop-filters.md)
* close three gaps found reviewing the admin console ([6ad62b5](https://adl.github.com/adl-developer/kinkane-backend/commit/6ad62b5aa6b3c6c79c39f699f0896bf7c41fc740)) — [details](changelog/2026-08-24-admin-console.md)
* separate unpaid checkouts from orders that actually need attention ([e22e0dc](https://adl.github.com/adl-developer/kinkane-backend/commit/e22e0dcf6632633bed8b85ae176543a593a94054)) — [details](changelog/2026-08-24-checkout-phone-number.md)
* stop the dashboard listing abandoned checkouts as recent orders ([d2608ef](https://adl.github.com/adl-developer/kinkane-backend/commit/d2608efdca770e6da54e38724c07d650ad18183d)) — [details](changelog/2026-08-24-checkout-phone-number.md)


## 2026-08-20

### Features

* make the Filters panel show what is actually there, and suggest books for the whole basket ([5158ca7](https://adl.github.com/adl-developer/kinkane-backend/commit/5158ca777f1e966cf9fa8cfeace7f7e3e43b48ef)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* add a shopping wishlist and give every author their own page ([42507c4](https://adl.github.com/adl-developer/kinkane-backend/commit/42507c4cdbccf4e6093dc33e2d76b3ea07183203)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* let people buy without an account, and give every order a trackable reference ([e7e97b6](https://adl.github.com/adl-developer/kinkane-backend/commit/e7e97b6a9f1052700645bf349238d7242bcefb34)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* hide books the shop cannot sell, and stop withdrawn titles appearing in search ([27097a3](https://adl.github.com/adl-developer/kinkane-backend/commit/27097a3ff7f2a20f3baabf04c49273369e53ff05)) — [details](changelog/2026-08-20-client-held-guest-basket.md)

### Bug Fixes

* stop discovery feeds offering books the shop cannot sell ([26ca985](https://adl.github.com/adl-developer/kinkane-backend/commit/26ca9850afe604586f599e6c39926f428464e51d)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* let customers actually buy the titles Gardners supplies to order ([bb45a13](https://adl.github.com/adl-developer/kinkane-backend/commit/bb45a136be83b4b9ae51fe2a1bb3b6aa37896456)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* stop hiding a third of the catalogue that Gardners can actually supply ([05f458d](https://adl.github.com/adl-developer/kinkane-backend/commit/05f458da1f1202a707a8d66f23080098cb06bfd3)) — [details](changelog/2026-08-20-client-held-guest-basket.md)
* get the wholesaler feed importing again, and stop asking people to sign in for recommendations ([611924e](https://adl.github.com/adl-developer/kinkane-backend/commit/611924e973647ea45336d74e779b15735ad58122)) — [details](changelog/2026-08-20-client-held-guest-basket.md)


## 2026-08-14

### Features

* document every endpoint in a private, browsable API reference ([aa7a9ab](https://adl.github.com/adl-developer/kinkane-backend/commit/aa7a9abdd691ba2202e44d4901706623d72f4a92)) — [details](changelog/2026-08-14-swagger-api-docs.md)


## 2026-08-13

### Features

* let social-login accounts change their plan with a fresh sign-in ([1e69091](https://adl.github.com/adl-developer/kinkane-backend/commit/1e69091a33e4a6a64ae5eb9021b679b0e7e3f1a4)) — [details](changelog/2026-08-13-pending-plan-clears-after-effect.md)

### Bug Fixes

* stop a book appearing on two pages when browsing with dedupe on ([58a9c2c](https://adl.github.com/adl-developer/kinkane-backend/commit/58a9c2c742ff6a4b2071c071af7ddd9252b1df03)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)
* log a loud warning when a plan change races the webhook that mirrors it ([2bdcf62](https://adl.github.com/adl-developer/kinkane-backend/commit/2bdcf629b7db0a472a29f50a3547c8e497f4d038)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)
* keep founding members on their founding price for every renewal ([445e499](https://adl.github.com/adl-developer/kinkane-backend/commit/445e499c6c1745aac2b6a18742a0c187b53e2cf7)) — [details](changelog/2026-08-13-cancel-reason-every-path.md)
* ask for a cancellation reason on every path that cancels ([f1f8520](https://adl.github.com/adl-developer/kinkane-backend/commit/f1f85206a0e24b674209aa06742104919a1da93f)) — [details](changelog/2026-08-13-cancel-reason-every-path.md)
* stop the account screen showing a plan change that has already happened ([d75a761](https://adl.github.com/adl-developer/kinkane-backend/commit/d75a76118dd83d4e72f4db2fc552a6910ab07343)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)
* keep a cart's timestamp in step with its line changes ([f623b4b](https://adl.github.com/adl-developer/kinkane-backend/commit/f623b4b8865a2bf214492beac055e303f5805747)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)
* keep the order and its payment record in step with each other ([3e739ad](https://adl.github.com/adl-developer/kinkane-backend/commit/3e739adcb15e4f7d1c99babce2cf529aed09ce5f)) — [details](changelog/2026-08-13-founding-lifetime-pricing.md)
* keep every subscription state change and its audit row in one transaction ([9310c44](https://adl.github.com/adl-developer/kinkane-backend/commit/9310c44622cd4b26c59bdb942b13c65a6ab8a249)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)
* finish paid orders even when the webhook has to be retried ([1af0560](https://adl.github.com/adl-developer/kinkane-backend/commit/1af0560d7e312f35150b67f5332b604180fb1442)) — [details](changelog/2026-08-13-order-payment-atomic.md)
* recover from a webhook handler crash on Stripe's next retry ([36ea9ef](https://adl.github.com/adl-developer/kinkane-backend/commit/36ea9ef44c069795160d2da0453405829f27ca03)) — [details](changelog/2026-08-13-atomic-state-audit-writes.md)


## 2026-08-11

### Features

* let subscribers switch plans and give a reason when cancelling, in-app ([d30209b](https://adl.github.com/adl-developer/kinkane-backend/commit/d30209ba9f6afa1811c9bf227c336248e0128410)) — [details](changelog/2026-08-11-subscription-change-plan-cancel-reason.md)
* pick the best edition of a book, and make deduping optional on browse/search ([ef53afb](https://adl.github.com/adl-developer/kinkane-backend/commit/ef53afbb4d3f4f9a376072426c3635187775575a)) — [details](changelog/2026-08-11-subscription-change-plan-cancel-reason.md)
* throttle how fast the payment confirmation screen can be polled ([4f84009](https://adl.github.com/adl-developer/kinkane-backend/commit/4f84009c853da2d72e8df8953207e2152d4451d7)) — [details](changelog/2026-08-11-payment-confirm-throttle.md)
* let readers buy books and manage payments without leaving the app ([8c3107a](https://adl.github.com/adl-developer/kinkane-backend/commit/8c3107aac48fb1057373202bdf30f73850fe02d8)) — [details](changelog/2026-08-11-dedupe-priority-and-opt-in.md)
* count referral link taps that open the app directly ([9f46d86](https://adl.github.com/adl-developer/kinkane-backend/commit/9f46d86797fe45667bdc9dc2ee62240807d07f4b)) — [details](changelog/2026-08-11-referral-app-clicks.md)
* count referral clicks as people rather than raw hits ([8a41e91](https://adl.github.com/adl-developer/kinkane-backend/commit/8a41e911e15941dc082a2b8891299621707a764a)) — [details](changelog/2026-08-11-referral-app-clicks.md)

### Bug Fixes

* bound the loop that generates referral codes and payment references ([1cdaf10](https://adl.github.com/adl-developer/kinkane-backend/commit/1cdaf10cea896608eb90f1afcbb5d94168f606ce)) — [details](changelog/2026-08-11-dedupe-priority-and-opt-in.md)
* stop user-keyed rate limiters erroring when a request has no account ([0fa159d](https://adl.github.com/adl-developer/kinkane-backend/commit/0fa159dcc03081e9c11d9c88108733d259f8752e)) — [details](changelog/2026-08-11-subscription-change-plan-cancel-reason.md)
* stop book checkout failing when the return URL has no query string ([b98f28e](https://adl.github.com/adl-developer/kinkane-backend/commit/b98f28e6808a8d7c0118aaba1adb677a0b3a0758)) — [details](changelog/2026-08-11-checkout-redirect-url.md)
* stop charging people who delete their account ([43827d8](https://adl.github.com/adl-developer/kinkane-backend/commit/43827d801a511ff821a99c88e6bff4d43998b871)) — [details](changelog/2026-08-11-stop-billing-deleted-accounts.md)
* let Founding Members cancel their subscription ([3f4a003](https://adl.github.com/adl-developer/kinkane-backend/commit/3f4a003a6ab8b96ecb016bc7b209d5f04e2736ec)) — [details](changelog/2026-08-11-founding-member-cancellation.md)
* show the real reason a subscription checkout was refused ([ea8e133](https://adl.github.com/adl-developer/kinkane-backend/commit/ea8e133729ca26ba386e9131d669da97456caac8)) — [details](changelog/2026-08-11-subscription-change-plan-cancel-reason.md)
* return referral point totals with camelCase keys ([f2350e3](https://adl.github.com/adl-developer/kinkane-backend/commit/f2350e34846e485c6192cb5a799c28024d8b7ff5)) — [details](changelog/2026-08-11-referral-camelcase-keys.md)


## 2026-08-10

### Features

* reward second-degree referrals, and make going around the world harder ([593fcfb](https://adl.github.com/adl-developer/kinkane-backend/commit/593fcfb07d1b1c712546b6d39840ae03f13e445d)) — [details](changelog/2026-08-10-referral-competition.md)
* use the Around the World invite wording, and switch it off when the campaign ends ([281e33b](https://adl.github.com/adl-developer/kinkane-backend/commit/281e33bef1cba09c5413ff8bd6fb625187c2d2b4)) — [details](changelog/2026-08-10-referral-competition.md)
* invite a friend and compete to send Kinkané around the world ([50131fd](https://adl.github.com/adl-developer/kinkane-backend/commit/50131fd8e225114ba6c109751fd34227313ee296)) — [details](changelog/2026-08-10-ecommerce-cart-checkout.md)

### Bug Fixes

* point every link at kinkane.app instead of kinkane.com ([88a44ff](https://adl.github.com/adl-developer/kinkane-backend/commit/88a44ffd042c9dd05c284b2738fd0ed083521336)) — [details](changelog/2026-08-10-ecommerce-cart-checkout.md)


## 2026-08-09

### Features

* find books by typing the author's name ([e028e82](https://adl.github.com/adl-developer/kinkane-backend/commit/e028e829714851845f4b1a5e64f19478a03129d1)) — [details](changelog/2026-08-09-author-search.md)


## 2026-08-07

### Features

* show the plan and renewal date on a user's profile ([e1a90d2](https://adl.github.com/adl-developer/kinkane-backend/commit/e1a90d2ff60eb8dee6517f5c975b22a9f5e7088a)) — [details](changelog/2026-08-07-remove-upgrade-endpoint.md)


## 2026-08-05

### Features

* send all email through Resend instead of SendGrid ([0722373](https://adl.github.com/adl-developer/kinkane-backend/commit/0722373d0073c412f9807d7af288c9c7acd0aa3a)) — [details](changelog/2026-08-05-resend-email-provider.md)
* make Unsubscribe stop marketing email only, not follow requests ([6c012cb](https://adl.github.com/adl-developer/kinkane-backend/commit/6c012cb310602f4d0ef4da8a3321ac5fe3ff3ef8)) — [details](changelog/2026-08-05-resend-email-provider.md)


## 2026-08-02

### Features

* let signed-in readers save their picks after retaking the quiz ([8104a39](https://adl.github.com/adl-developer/kinkane-backend/commit/8104a3967e18d271c24c24bc1c3d6c5856babd30)) — [details](changelog/2026-08-02-quiz-retake-selections.md)
* accept Firebase credentials as one base64 variable ([64275b2](https://adl.github.com/adl-developer/kinkane-backend/commit/64275b228dfc995bca9d8aee2f14600250b461d0)) — [details](changelog/2026-08-02-firebase-service-account-base64.md)
* let readers subscribe to Kinkané Plus ([511cbb2](https://adl.github.com/adl-developer/kinkane-backend/commit/511cbb24ef168732bdce3e59c4bd8fba6551dcbf))
* remember every subscription state a reader passes through ([f168dae](https://adl.github.com/adl-developer/kinkane-backend/commit/f168dae46b04667e1013829dad0e9c1fdf4f131b)) — [details](changelog/2026-08-02-firebase-service-account-base64.md)


## 2026-07-31

### Features

* stop recommending books a reader has already read or rejected ([05a81ae](https://adl.github.com/adl-developer/kinkane-backend/commit/05a81ae133f20802c7bfd6bac4a8c66d5d2e8af0)) — [details](changelog/2026-07-31-disliked-books.md)


## 2026-07-30

### Features

* base trending on what readers actually view, like and read ([b5e60a4](https://adl.github.com/adl-developer/kinkane-backend/commit/b5e60a41798e3c1f7edac05565fefc7b50f4264a)) — [details](changelog/2026-07-30-trending-real-signals.md)


## 2026-07-29

### Features

* accept whatever "things to avoid" options the onboarding screen offers ([f7cbb8f](https://adl.github.com/adl-developer/kinkane-backend/commit/f7cbb8f1cb8c31431180873f1ed54926a8ca842b)) — [details](changelog/2026-07-29-preference-history.md)
* keep a permanent record of how a reader's preferences change over time ([322be4c](https://adl.github.com/adl-developer/kinkane-backend/commit/322be4cdc744d951964bb913b6e45d0652cd31f5)) — [details](changelog/2026-07-29-preference-history.md)


## 2026-07-28

### Bug Fixes

* stop book search timing out on ordinary title searches ([a510985](https://adl.github.com/adl-developer/kinkane-backend/commit/a510985d10eef1a0fa9a66dff844ae764bcc3f37))


## 2026-07-27

### Features

* require sign-in to view "You May Also Like" recommendations ([ddfcd89](https://adl.github.com/adl-developer/kinkane-backend/commit/ddfcd8986b7deecb884a52edbc76bbf9ac825a29)) — [details](changelog/2026-07-27-books-search-count-cap.md)


## 2026-07-26

### Features

* apply Figma-accurate styling to all 16 email templates ([4dc5d8d](https://adl.github.com/adl-developer/kinkane-backend/commit/4dc5d8d919aa382e7f209e064a0043228bc8c410)) — [details](changelog/2026-07-26-trending-fallback-missing-index.md)
* add backfill pass to recommendations so niche readers always get a full list ([8a41bf0](https://adl.github.com/adl-developer/kinkane-backend/commit/8a41bf085086f370b332702dd12f1124235e07e9)) — [details](changelog/2026-07-26-books-list-search-latency.md)
* branded email layout, real logo, and one-click unsubscribe ([c34c01b](https://adl.github.com/adl-developer/kinkane-backend/commit/c34c01b3fdcfbd09c1dd6d93ab7278b0e97162e0))

### Bug Fixes

* stop trending's fallback from scanning every book ([6d6b49a](https://adl.github.com/adl-developer/kinkane-backend/commit/6d6b49ae6efaf480a90f744691dce82781a77ea7)) — [details](changelog/2026-07-26-books-list-search-latency.md)


## 2026-07-25

### Features

* let people sign up without finishing onboarding first ([d0f6fa0](https://adl.github.com/adl-developer/kinkane-backend/commit/d0f6fa065d621e052e4f1670ec0ba275987063a1)) — [details](changelog/2026-07-25-optional-guest-session-signup.md)

### Bug Fixes

* stop deploys failing when the index build needs more memory ([be01bd6](https://adl.github.com/adl-developer/kinkane-backend/commit/be01bd64307cb72525b62a2bbb084d33cc356fc0)) — [details](changelog/2026-07-25-parallel-index-build-shared-memory.md)
* speed up the vector search index build during deploys ([ab1768a](https://adl.github.com/adl-developer/kinkane-backend/commit/ab1768a38f6866ff1fae3f0f308790301b42450b)) — [details](changelog/2026-07-25-parallel-index-build-shared-memory.md)
* make book and author search actually use their trigram index ([4a14d7b](https://adl.github.com/adl-developer/kinkane-backend/commit/4a14d7ba0a3a0119eb6bf118a3e6ac000eb4eb02)) — [details](changelog/2026-07-25-books-list-count-caching.md)
* stop book browsing and recommendations from loading slowly ([818e55f](https://adl.github.com/adl-developer/kinkane-backend/commit/818e55f2a45d333dbe53fd86227bee1214de27be)) — [details](changelog/2026-07-25-books-recommendations-performance.md)


## 2026-07-24

### Features

* add Gardners dropship order submission and ack polling ([ca7a130](https://adl.github.com/adl-developer/kinkane-backend/commit/ca7a130641bfa70ae134ea1f8927b3f2a6b13add)) — [details](changelog/2026-07-24-gardners-dropship-ordering.md)

### Bug Fixes

* stop reader-type quiz from defaulting to "The Seeker" on mixed picks ([bac167b](https://adl.github.com/adl-developer/kinkane-backend/commit/bac167b9e0f6461c21546fdeb9470a0188aca6d4)) — [details](changelog/2026-07-24-reader-type-prompt-tuning.md)
* stop non-fiction books from crowding out fiction recommendations ([2985a2c](https://adl.github.com/adl-developer/kinkane-backend/commit/2985a2c223ff987a78fc8504d5953c61efc66b9b)) — [details](changelog/2026-07-24-fiction-format-filter.md)


## 2026-07-23

### Features

* record trial history and persist trial expiry instead of computing it on the fly ([a9cbab8](https://adl.github.com/adl-developer/kinkane-backend/commit/a9cbab8c0e21a157412271e96f3ac79458ba358d)) — [details](changelog/2026-07-23-subscription-trial-audit-trail.md)
* add an in-app notifications feed ([d9f1d66](https://adl.github.com/adl-developer/kinkane-backend/commit/d9f1d66defbae7b6da2e6eed1eaacc9e33fc331a)) — [details](changelog/2026-07-23-notifications-feed.md)
* stop search suggestions from showing the same book twice ([10cfe28](https://adl.github.com/adl-developer/kinkane-backend/commit/10cfe2821aa954d890df5930c7544994f19f08fd)) — [details](changelog/2026-07-23-dedupe-search-results.md)
* allow partial feelings/genres in recommendation requests and avoid repeat picks ([25458b4](https://adl.github.com/adl-developer/kinkane-backend/commit/25458b44f67e62ed0782fa4181838597dadfbdf8))
* add profile details and trial status to the account info endpoint ([5459c80](https://adl.github.com/adl-developer/kinkane-backend/commit/5459c8080297ba74baaceabb454c74af190c5a13)) — [details](changelog/2026-07-23-stop-like-comment-emails.md)

### Bug Fixes

* stop emailing users when someone likes or comments on their post ([3047387](https://adl.github.com/adl-developer/kinkane-backend/commit/30473872844f77b60f7cdd6265f5830ae22cbf9b)) — [details](changelog/2026-07-23-stop-like-comment-emails.md)
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

