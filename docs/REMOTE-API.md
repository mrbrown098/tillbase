# Remote read-only reports: API design

Status: **design for approval by Main and the owner. Nothing here is built, and no server code may be written until the architecture is approved.** Do not describe it in the README, release notes or the app as available.

Scope: the first customer is one shop with one laptop. The owner wants to look at reports from a phone. This document designs the smallest safe way to do that. It builds on `docs/ONLINE-ACCESS.md` and the deployment proposal (`docs/ARCHITECTURE.md`, branch `docs/deployment-architecture`, not yet merged: re-check it when it lands). Where they disagree, that proposal wins.

## 1. Goals and non-goals

Goals
- The owner reads sales, day close, profit, stock and the audit trail from a phone browser.
- Read-only. A phone cannot sell, refund, void, change a price or change staff.
- The till keeps working with no internet. Remote access is off by default.
- No database port is ever opened. Nobody gets the SQLite file.
- Free to run; no Tillbase-run server; nothing sold or tracked.

Non-goals (for this design)
- Remote selling, two-way sync, several branches, staff logins from a phone, customer-facing pages.
- Replacing SQLite.

## 2. What exists that this design uses

- `DayCloseService.report(date)`: every day-close figure, computed in the core.
- `FinanceService.profitAndLoss`, `SalesReportService`, stock and low-stock reads in core.
- `audit_log` (append-only, migration v12) and the `audit.view` permission (owner only).
- Permissions are enforced by `electron/handlers.ts` on each call, re-reading the user's role. Remote endpoints must reuse that same enforcement, not copy it.

## 3. Shape of the system (the one decision that needs approval)

A phone cannot reach a laptop that sits behind a shop router, and the laptop must never be exposed directly. Three options:

| | A. Customer-owned small server that receives pushed snapshots | B. Secure tunnel / VPN to the laptop | C. Tillbase-run relay |
|---|---|---|---|
| How | The laptop pushes read-only report snapshots over HTTPS to a tiny server the owner controls (a cheap VPS or a free-tier worker the owner owns). The phone talks only to that server. | The owner installs a tunnel product (for example a mesh VPN) and the laptop serves reports on its private address. | Tillbase hosts it. |
| Laptop exposed to the internet | No (outbound only) | No (but depends on a third-party product and its account) | No |
| Works when laptop is off | Shows the last snapshot, clearly dated | No | Last snapshot |
| Complexity for a non-technical owner | Medium (one-time setup by us or a helper) | High | Low, but Tillbase becomes a data company |
| Data held by someone else | The owner's own server | Nobody | Tillbase: **rejected** by the project's principles |

**Recommendation: A.** The laptop is the source of truth and only makes outbound HTTPS calls. The server stores snapshots and serves them read-only to the owner. It never writes to the shop database and has no route that could. Option B stays documented as a supported alternative for technical owners. C is out.

Because the data is a snapshot, "live" means "as of the last push" (target: after every sale and at day close, and every 5 minutes as a heartbeat). The phone always shows the snapshot time.

## 4. Report endpoints (read-only)

All under `/v1`, JSON, `GET` only. Any other method returns 405. Money is whole minor units as integers, as everywhere else. Every response carries `asOf` (when the shop computed it) and `schema` (an integer API version).

| Endpoint | Returns | Source |
|---|---|---|
| `GET /v1/day-close?date=YYYY-MM-DD` | `DayCloseReport` (profit included for the owner) | `DayCloseService` |
| `GET /v1/sales/summary?from=&to=` | totals, by method, by day, voids, refunds | sales report |
| `GET /v1/profit-loss?from=&to=` | `ProfitAndLoss` | `FinanceService` |
| `GET /v1/stock/low` | items at or under their reorder level | inventory |
| `GET /v1/shifts?date=` | shifts with counted cash and variance | `ShiftService` |
| `GET /v1/audit?from=&to=&action=&limit=` | audit entries (owner only, redacted as stored) | `AuditService` |
| `GET /v1/status` | shop name, `asOf`, schema, whether the till last reported recently | snapshot |

No endpoint returns PINs, hashes, salts, tokens, customer phone numbers, or raw payment references. Date ranges are capped (for example 366 days) and `limit` is capped (for example 500).

Report figures are produced by the same core services on the laptop and shipped as data. The server and the phone never calculate money.

## 5. Authentication, sessions and devices

- **Owner only.** Cashiers and managers cannot sign in remotely. (A later "manager can view day close" role is possible but is not part of this design.)
- **Not the till PIN.** A 4-digit PIN is not remote-grade. The owner sets a separate long passphrase for remote access (at least 12 characters, checked against a short list of common ones). The server stores only a slow hash (Argon2id, or scrypt where Argon2 is unavailable), with a per-account salt.
- **Optional second factor** (time-based codes). Recommended and on by default in the setup guide; a decision for the owner is listed in section 9.
- **Sessions:** random 256-bit tokens, stored hashed on the server, sent in an `HttpOnly; Secure; SameSite=Strict` cookie. Idle expiry 30 minutes, absolute expiry 12 hours. Sign-out revokes the token on the server.
- **Devices:** the first sign-in from a new phone needs approval from the till (a short pairing code shown in Settings on the laptop). Paired devices are listed with last-used time and can be revoked from the laptop or from any signed-in session. A revoked device loses access on its next request.
- **Lockout:** 5 wrong passphrases lock the account for 15 minutes, doubling each time up to 24 hours, counted per account and per source address. Responses do not reveal whether the account exists.
- **Laptop-to-server channel:** a separate machine credential (long random key created at setup, stored only on the laptop and, hashed, on the server) that can only call the snapshot push endpoint. It cannot sign in as the owner and cannot read other shops' data.
- Changing the remote passphrase or revoking all devices ends every session.

## 6. Audit trail

- The server keeps its own append-only access log (sign-in, failed sign-in, lockout, new device, device revoked, each report read: who, device, time, endpoint, address). The same no-update, no-delete rule applies.
- Remote events that matter (pairing approved, device revoked, remote access turned on or off, passphrase changed) are also written to the shop's `audit_log` on the laptop the next time it syncs, so the owner sees them in the same place as everything else. New `AuditAction` values will be added when this is built (contract change, not now).
- Failed remote sign-ins and lockouts are never silent: the owner sees them on the Home screen of the till.

## 7. Transport security (TLS)

- HTTPS only. The server refuses plain HTTP; HSTS on.
- Certificates from a public authority through a reverse proxy the owner or their helper runs (for example Caddy, which renews automatically), or the free-tier host's own certificate. This needs a name; a free subdomain is acceptable to start.
- The laptop pins nothing and exposes nothing; it only calls out. A browser cannot pin certificates, so the phone relies on the public authority system.
- No self-signed certificates and no "tap to trust" for the phone. A local-network server (deployment model B in the architecture proposal) has the harder certificate problem described there; this design avoids it by never serving phones from the laptop.
- Security headers on every response (`Content-Security-Policy` with no third-party scripts, `X-Content-Type-Options`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API responses).
- Rate limiting on all routes, and a hard cap on request size.

## 8. Data handling

- The snapshot is what the owner agrees to send: reports only, never the database file, never staff PIN data, never raw customer lists. Settings shows exactly what is sent, with a "send a test snapshot" button and a "turn off and delete remote data" button.
- Data at rest on the server: encrypted disk and encrypted backups are the owner's responsibility and are part of the setup guide. (Client-side end-to-end encryption, as sketched in `ONLINE-ACCESS.md`, cannot coexist with server-side report filtering and the owner-only permission checks unless the server holds keys. For a server the owner owns, TLS plus disk encryption is proposed. End-to-end stays an option for any future third-party relay.)
- Retention: the server keeps snapshots for the periods the owner chooses (default 400 days). Turning remote access off deletes them.
- Each shop has its own data partition; no query can cross shops.

## 9. Decisions needed from Main and the owner

1. Approve option A (owner-controlled server fed by outbound pushes) as the first remote architecture, with B as a documented alternative.
2. Hosting: a small VPS the owner rents, a free-tier worker in the owner's account, or "we set it up once for you". Who pays and who does the setup for the first customer?
3. Second factor: required, or recommended only? (Recommended: required for any server reachable from the internet.)
4. Snapshot freshness: is "as of the last sale, at most 5 minutes old, with the time always shown" enough for the owner?
5. Which reports are in the first release (suggest: day close, sales summary, low stock; profit and audit second).
6. Whether managers ever get remote day-close access (suggest: not in version one).

## 10. Acceptance criteria before any of it ships

- The server code has no route that writes to shop data; a test enumerates the routes and fails on any non-GET report route.
- Every endpoint: tests for signed-out (401), wrong role, revoked device, expired session, over-range dates, and the redaction rules.
- Lockout, session expiry and device revoke are tested with a fake clock.
- The snapshot contains no PIN, hash, salt, token or phone number (a test scans it).
- TLS-only behaviour is tested (plain HTTP refused).
- A restore drill: back up the laptop, restore, push a snapshot, and the day-close totals on the phone match the laptop.
- The wording in the app and the docs says "snapshot as of <time>", never "live".

## 11. Build order (after approval)

1. Extract the transport-neutral report functions so a snapshot builder can call them (no Electron imports).
2. Snapshot builder and "what is sent" screen on the laptop (offline testable).
3. The small server: sign-in, sessions, devices, snapshot receive, the `GET` endpoints, access log.
4. Pairing and revoke on the laptop; audit entries.
5. Phone-sized report pages (W2).
6. Setup guide, hardening checklist and a pilot with the first customer.
