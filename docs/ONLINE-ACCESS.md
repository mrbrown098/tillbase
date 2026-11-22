# Online access (design)

Goal: an owner or admin can sign in from any browser, and a second computer can read and write the same shop's data, without Tillbase ever being a "data company". Free to run, free to self-host, no subscription.

## Principles
1. **The till stays local-first.** The desktop app and its SQLite file keep working with no internet. Online access is optional and off by default.
2. **We cannot read your data.** Everything sent to the cloud is encrypted on the shop's computer with a key the server never sees (end-to-end). The server stores locked boxes.
3. **Free to run.** Cloudflare free tier (Workers for the API, D1 for storage, Pages for the website). No domain needed to start (`*.workers.dev`, `*.pages.dev`). The server is small and portable so anyone can self-host it on a cheap VPS.
4. **Nothing sold, nothing tracked.** No analytics, no third-party scripts in the app or the portal.

## Accounts and keys
- Owner creates an online account with email and a long passphrase (separate from the till PIN).
- From the passphrase the browser or app derives two keys with a slow key-derivation function (Argon2id via WebCrypto/WASM, or PBKDF2-SHA256 at 600,000 rounds as the fallback): an **auth key** (sent to the server, proves who you are) and a **wrapping key** (never sent).
- A random **shop data key** encrypts the data. It is stored on the server only after being wrapped with the wrapping key. Forgotten passphrase = data is unrecoverable, so setup shows a printable recovery code.
- Staff cannot reach the portal. Owner and admins only. Cashier PINs stay local to each till.

## What syncs
Tillbase's data is already mostly an append-only log (sales, stock movements, customer ledger, payments). Sync ships **change records**, not whole files:
- Each till has a device id. Every record has a globally unique id and a device sequence number.
- A change record = table, id, operation, timestamp, device, and an encrypted payload.
- Append-only tables never conflict. Editable rows (products, prices, settings) use last-writer-wins by timestamp, and the loser is kept in a "history" list.
- Receipt numbers and order tokens stay per device (device prefix, e.g. T1, T2), which is already how receipt numbers are built.
- Stock is always the sum of the log, so two tills selling the same item both reduce stock correctly.

## Phases
1. **Read-only portal** (smallest useful thing). Each till uploads encrypted daily summaries and recent sales. The owner opens a web page, enters the passphrase, and sees sales, profit and low stock from anywhere. No two-way sync, so no conflict risk.
2. **Two-way sync** between tills of the same shop using the change log, with a "sync status" light in the app.
3. **Branches**: several locations under one owner, with per-branch and combined reports.

## Pieces to build
| Piece | Where | Notes |
|---|---|---|
| Cloud API | `cloud/` (Cloudflare Worker, Hono, D1) | sign-up, login, store and fetch encrypted change records, rate limits, no plaintext |
| Web portal | `portal/` (Vite + React, Cloudflare Pages) | decrypts in the browser, read-only reports first |
| Sync engine | `packages/core/src/sync/` | change log, encryption, push/pull; fully unit-tested with a fake server |
| Desktop settings | Settings, "Online access" section | connect, status, disconnect, recovery code |

## Free-tier limits (honest)
Cloudflare D1 free: about 100,000 row writes a day and 5 GB total. A busy shop writes a few thousand rows a day, so one deployment serves a modest number of shops. If it grows, the same server runs on any small VPS or the owner's own Cloudflare account (the portal can point at a self-hosted server in Settings).

## Not in scope yet
Customer-facing pages, payments, online ordering, SMS, e-invoicing for tax authorities.
