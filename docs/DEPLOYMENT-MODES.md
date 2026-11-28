# Deployment modes: proposal

Status: **proposal only. Nothing in this document is built, and the app does not offer any of it.** Tillbase today
is one mode: everything runs on one computer and the data stays there. This page says how the other modes should
be chosen and configured when they exist, so the screens, settings and warnings are agreed before the code is.

## The four modes

| # | Mode | Where the data lives | Who runs what | State |
|---|---|---|---|---|
| 1 | Standalone, offline | The shop computer's SQLite file | One app, one computer | **Built (this is Tillbase today)** |
| 2 | Owner computer as LAN server | SQLite file on the owner's computer | Owner computer runs the server; tills on the shop network connect as clients | Not built |
| 3 | Customer's own server (self-hosted cloud) | SQLite file on a server the customer controls | Customer runs the same server; tills connect over the internet (HTTPS) | Not built |
| 4 | Hybrid: local first, synced to a server | A SQLite file on every till and one on the server | Tills keep working offline and sync when they can | Not built, needs a sync design |

There is no Tillbase-hosted cloud in any mode: no Tillbase account, no subscription, nothing sent to us.

Modes 1 to 4 here are modes A to D in [ARCHITECTURE.md](ARCHITECTURE.md), which sets out the server's security boundaries and the phases. This document covers the screens and warnings. The "tills" below are Tillbase apps; staff using a phone or tablet browser are covered under "Browser clients and certificates".

## How it fits the current architecture

- The data rules already live in `@tillbase/core` and every call goes through `createHandlers` in
  `electron/handlers.ts`. Modes 2 and 3 add a second way to reach the same handlers (an HTTPS transport next to
  Electron IPC). No business rule is rewritten.
- **One thing must change first.** `createHandlers` keeps the signed-in user in a single variable (`current`), so
  one instance serves one person. A server needs one session per connected till (a handlers instance per
  connection sharing one database, or a session id passed into each call). The fixed terminal prefix `"T1"` used
  for order tokens must become a per-till value.
- The renderer talks to `window.tillbase` through the `TillbaseApi` interface. A client till would get a second
  implementation of that interface that calls the server instead of IPC, so the screens stay as they are.
- SQLite stays the only store. In mode 2 and 3 exactly one process writes to it. Never share the file over a
  network drive: SQLite file locking is not reliable there and it corrupts data.
- Stock (`stock_movements`) and customer balances (`customer_ledger`) are already append-only logs with UUID
  ids. That is what makes mode 4 possible later, but it is not enough alone (see mode 4).

## Where the choice is made

**Onboarding stays as it is.** The first-run guide asks nothing about deployment, because the only working answer
is "this computer", and a question with one answer is noise. When a second mode is built it appears as one new
step, "Where will your data live?", placed after "Country and currency", and only with the modes that actually
work in that release. A mode that is not built is never shown, greyed out or labelled "coming soon" in the app.

**Settings gets one section, "Where your data lives".** Until a second mode exists it is a single read-only line:
"Your data is stored on this computer. Backups are kept next to it." That is true today and has no button.

Changing mode later is a deliberate action in that section, never a side effect of another setting.

## Screens needed, per mode

### Mode 2: owner computer as LAN server

Server side (owner computer), in Settings, "Where your data lives":
1. **Turn on sharing** with a plain explanation: "Other tills on your shop network will be able to sell using this
   computer. This computer must stay on during opening hours."
2. **This computer's address** (read from the network, shown as `https://192.168.x.x:port`) and a QR code / short
   code for pairing.
3. **Paired tills**: list with name, last seen, and a "Remove" button that takes effect immediately.
4. **Pair a new till**: shows a one-time code, valid for 5 minutes, for entering on the new till.
5. **Turn off sharing**: asks for confirmation; connected tills are signed out and shown a clear message.

Client side (a till), shown only when no local data exists or when the owner chooses "Connect this till":
1. Choose "Connect to the owner's computer".
2. Enter the address (or scan) and the one-time code. Real connection test: the button runs an actual request and
   reports exactly what failed (cannot reach the address, certificate not recognised, code expired).
3. Sign in with the person's own PIN as today. A paired till still enforces every permission on the server.

### Mode 3: customer's own server

1. A separate server build (Node + the same core), distributed as a documented Docker image and a plain Node
   start script. Installation is the customer's work; the app does not provision servers.
2. In the till: "Connect to your own server", with the server address, the owner's PIN and a pairing code made on
   the server's admin page.
3. The server has a small admin page for pairing codes, paired tills, backups and the version.
4. TLS is required. The server refuses plain HTTP except on localhost, and the till refuses to connect without
   TLS.

### Mode 4: hybrid

Not specified in detail until the sync design below exists. Screens it will need: sync status per till (last
successful sync, number of changes waiting, conflicts needing a person), a "Sync now" button that really syncs,
and a conflict review list.

## Technical requirements before each mode can be shown

| Requirement | Mode 2 | Mode 3 | Mode 4 |
|---|---|---|---|
| Per-connection sessions in handlers (above) | yes | yes | yes |
| HTTPS transport for `TillbaseApi`, same permission checks | yes | yes | yes |
| Device pairing (one-time code, per-till secret, revoke) | yes | yes | yes |
| Per-till terminal id for tokens and receipts | yes | yes | yes |
| Self-signed certificate created on first use, pinned by the Tillbase app (desktop tills only; a browser cannot pin, see below) | yes | no (customer's certificate) | depends |
| Offline behaviour of a client till when the server is unreachable | "cannot sell" message | same | works offline by design |
| Server backups with the existing `backup.ts` | yes | yes | yes |
| Schema version check between client and server | yes | yes | yes |
| Sync log, idempotent replay, clock handling, conflict rules | no | no | **yes, a design document of its own** |

Mode 4 cannot be a flag on mode 3. Open questions that need a design first: how a till that sold offline and a
server that changed the same product price resolve a clash; how two tills selling the last unit offline are
reconciled (stock can go negative, and the app must say so); how void and return of a sale made on another till
are handled; and how a till that was off for days replays safely. Document this before writing code.

## Migration warnings and confirmation steps

Every move between modes is a data move, so each one needs the same shape: a plain-words warning, a backup, a
typed confirmation, and a way back.

- **Standalone → LAN or own server.** Warning: "This computer's sales, stock and customers will become the shop's
  shared data. Other tills will see and change it." Steps: automatic backup first (shown with its file name),
  then the owner types the shop name to confirm. The original file stays untouched as the backup.
- **Client till → Standalone.** Warning: "This till will stop using the shop's server. It does not have a copy of
  the shop's data." The till starts empty unless the owner restores a backup. No silent copy is made.
- **Server → different computer.** Done with backup and restore (`backup.ts`), and the old server is turned off
  before the new one is turned on, so two servers never accept sales at once. The restore screen says this.
- **Version mismatch.** A client whose app version is older or newer than the server's schema version is refused
  with "Update this till to version X". It never writes to a database it does not understand (migrations are
  append-only, so newer data may exist).
- **Turning a mode off** never deletes data on the server or on any till.

## Security explanations to show in the app

Each of these must be true of the shipped code, not aspirational. Show them next to the control they describe.

- **Sharing on the shop network.** "Anyone on your shop Wi-Fi who knows the pairing code can connect a till while
  a code is active. Use a Wi-Fi password and do not share the code." Codes are single-use and expire in 5 minutes.
- **Encryption.** "Tills talk to the server over an encrypted connection." True only with TLS on (required, not
  optional). For the self-signed certificate: the first pairing pins its fingerprint; a changed certificate stops
  the connection with a warning rather than continuing.
- **Browser clients and certificates.** A phone or tablet browser cannot pin a certificate. It either trusts the certificate or shows a full-page warning, and a page on a plain `http://` address or a bare LAN address such as `https://192.168.x.x` with an untrusted certificate is not a "secure context", so browsers switch off camera access (barcode scanning with the phone camera) and installing the page as an app. Three ways to give browsers a trusted connection are open for decision, and none is built:
  1. A certificate from a public authority for a name the shop owns that points to the server's private address (needs a domain name and a DNS-based certificate request).
  2. A certificate authority made for the shop and installed on each device. It works, but the steps differ on every phone and the owner must protect the authority's key.
  3. No encryption on the shop network. Basic screens work, but camera scanning and app installation do not, and anyone on the Wi-Fi could read the traffic.
  Until one is chosen, browser access must not be described as secure in the app or the documentation.
- **PINs.** PINs identify staff at the till; they are not a defence against someone with access to the server
  computer or its disk. The server stores PIN hashes only, never the PINs, and limits wrong attempts per till.
- **Own server.** "You are responsible for this server: updates, backups, firewall and who can log in to the
  machine. Tillbase does not see your data." The setup page links to a short hardening checklist.
- **Backups.** Backups are copies of everything, including customer names, phone numbers and balances. They are
  as sensitive as the live data and the screen says where they are.

## Settings keys (proposed)

Same pattern as `business.*` and `printer.*`: keys in the `settings` table, no migration, written by a small
service in core.

- `deploy.mode`: `standalone` (default; absent means standalone), `lan_server`, `lan_client`, `server_client`.
- `deploy.serverUrl`, `deploy.tillName`, `deploy.pairedAt`: client side.
- A till secret is stored with the OS-level protection Electron offers (`safeStorage`) where available, not in
  the settings table in plain text. Server side, paired-till records are a table and need a migration.

## What should not be built

- A mode picker that lists modes which do not work.
- "Test connection" buttons that do not open a real connection.
- A sync status badge before there is a sync.
- Any Tillbase-operated relay, account or login.

## Suggested order

1. Per-connection sessions and per-till terminal ids (a refactor with no visible change).
2. HTTPS transport, pairing and the client implementation of `TillbaseApi`: mode 2, then mode 3 comes almost free
   because it is the same server on a different computer with the customer's TLS.
3. The sync design document, reviewed, then mode 4.
