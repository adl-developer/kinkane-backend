# Fix Gardners dropship connection: it's FTPS, not SFTP

**Date:** 2026-08-03

## What changed

The Gardners dropship (I12 Home Delivery) module added in
[2026-07-24-gardners-dropship-ordering.md](2026-07-24-gardners-dropship-ordering.md)
assumed the ordering account was SFTP, matching onix_ingester's Bespoke
Inventory feed account. Once real credentials arrived, a live login test
showed that assumption was wrong on two counts:

1. **Protocol.** The account is explicit FTPS ("FTPeS") on
   `orders.gardners.com`, not SFTP — a different host and a different
   protocol from the Bespoke Inventory account, despite both using a
   `KIN155FTP`-style username.
2. **Directory casing.** The real server's directories are lowercase
   (`homeord`, `homeack`, `homedisp`, `homegen`, `homepre`) — the I12 spec
   PDF prints them uppercase, but FTP paths are case-sensitive here.

Swapped `ssh2-sftp-client` for `basic-ftp` (already used in onix_ingester for
the Covers FTP account) with `secure: true` for explicit TLS, and fixed the
directory constants to lowercase. Env vars renamed
`GARDNERS_DROPSHIP_SFTP_*` → `GARDNERS_DROPSHIP_FTP_*`, default port 22 → 21.

## Verification

- Live login confirmed via `curl --ftp-ssl` before touching any code, to
  isolate "is the password right" from "does the client library work."
- After the rewrite, a direct `basic-ftp` connection + directory listing
  against `orders.gardners.com` succeeded from Node.
- Ran a full `testing: true` order through `createAndSubmit` → `pollAck`
  against the live server. The `.ORD` file uploaded to `homeord`
  successfully, but no `.ACK` appeared within 5 minutes of polling — the
  order file was still sitting unprocessed in `homeord` at that point.
  Conclusion: Gardners' Home Delivery order processing is not near-real-time;
  turnaround is unproven but longer than a few minutes, likely a batch cycle
  similar to the other Gardners feeds (hourly/daily cadences documented for
  backorders/dispatch/ASN elsewhere in the spec). Not a bug in this code —
  a live end-to-end test needs to be checked back on rather than awaited
  synchronously in one sitting.
- `tsc --noEmit` clean, full test suite (80 tests) passes unaffected.

## What's still unverified

Everything past order submission — ack turnaround time, dispatch, and
invoicing — since Gardners hadn't processed the live test order within the
observation window. A follow-up check against order id 2 (`19FC75D9980.ORD`,
testing mode) will confirm the ack side once Gardners' batch cycle runs.
