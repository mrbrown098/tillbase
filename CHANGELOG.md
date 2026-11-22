# Changelog

All notable changes to Tillbase are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Open-source housekeeping: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue forms for bug reports and feature requests (asking for operating system, Node version and app version), a pull request template, weekly Dependabot updates for npm and GitHub Actions (minor and patch grouped), a CodeQL code-scanning workflow, and `docs/PACKAGING.md` with the plan for winget, Scoop and Homebrew.
- The sponsor list (`ads/`): an empty, validated `manifest.json` (zero sponsors), its JSON schema, the written sponsor policy, and a checker (`scripts/validate-ads.mjs`) that runs in CI on every pull request that touches `ads/`. Nothing is shown in the app yet.
- A "Fresh clone" check in CI that does what a new contributor does on a new machine (clean checkout, newest npm, `npm ci`, build, launch the app) on Linux, Windows and macOS with Node 22 and 24. It fails if Electron's program was not downloaded, and a separate check on every pull request fails if `package-lock.json` fetches anything over git.
- A new **Home** screen for owners and managers: today's sales and profit, open orders, what is running low, the latest sales, and one-tap shortcuts. Cashiers still start on Checkout.
- A tidier side menu: grouped into Sell, Shop, Manage, Business and System, with icons, the shop's name and logo, and whether a shift is open.
- **Shop logo**: upload your own logo in Settings. It shows in the app, on the sign-in screen and above printed receipts and statements.
- The Tillbase logo now shows in the app, the sign-in screen and the window, and in the README.
- Receipts and statements end with a small "Powered by Tillbase" and copyright line. You can switch it off in Settings.
- **Khata (customer credit).** A customer can now buy on account. At the till and on orders, pick the customer and tick "Put on account (pay later)": put the whole bill on account, or just part of it and take the rest in cash or card. You can set a credit limit for each customer (managers only); a sale that would go over the limit is refused and tells you how much you can still put on account.
- **Owes you.** A new list on the Customers screen shows everyone who owes you money, largest first, with the total. Each customer has a statement of every sale on account, repayment and write-off with what they owed after each one, and you can print it for 58 mm or 80 mm paper.
- **Repayments.** Cashiers and managers can record money a customer pays back, by cash or card. Cash goes into the drawer count for the open shift, so the cash you expect stays right. A sale on account is counted as sales income but is never counted as cash or card received.
- Managers can write off what a customer owes, with a reason that stays on their statement. Voiding a sale on account takes it off what the customer owes.
- Database migration 9 (credit limit and account entries on the customer ledger; migrations 7 and 8 are reserved).

### Fixed
- The sign-in screen now shows exactly as many empty boxes as your PIN has digits (so an 8-digit PIN shows 8 boxes) and signs you in on the last digit. Accounts made earlier learn their length the first time they sign in.
- Installing from source with npm 11.2x and newer no longer leaves Electron without its program file ("Electron failed to install correctly"): the packages that need their install step (Electron, esbuild, SQLite) are now approved in `package.json`.
- Installing from source with a recent npm (11 and newer) no longer fails with `EALLOWGIT`: a build tool that was fetched over git/SSH is now taken from the normal npm registry.

## [0.5.0] - 2026-11-21

### Added
- Backups to a second place: the owner can choose a USB drive or a Dropbox or Google Drive folder on the new Backups screen, and every backup is copied there too. A missing folder never stops selling; it shows a plain warning.
- Restore from a backup (owner only): the backup is checked first, the current data is kept as `tillbase.sqlite.before-restore`, and Tillbase restarts on the restored data.
- Export for your accountant: on the Money screen (owner only), save five Excel-ready CSV files for any date range: sales by day with tax, running costs by category, purchases, payroll, and profit and loss.
- Customers and loyalty: customer records with phone search at the till and on orders (quick-add included), points earned on every sale at a rate the shop sets (default 1 point per 100.00 of items before tax), points used as a discount on the items, a prepaid wallet, and a Customers screen with history, a points and wallet ledger, top-ups and manager corrections. Receipts show points used and earned and the balances. Delivery orders fill in the address from the customer. Only the owner sees what a customer has spent.
- Database migration 6 (customers, an append-only customer ledger, customer links on orders and sales).

## [0.4.0] - 2026-11-21

First tagged release. Everything below was built between 17 and 21 November 2026; earlier work had no release numbers, so this entry describes the whole product as of today.

### Added

**Selling**
- Core point-of-sale engine: products, barcode lookup, stock movements, transactional checkout, voids that restore stock exactly, daily reports, and receipts for 58 mm and 80 mm printers.
- Checkout screen with search and barcode entry, quantities, line discounts, tax, change due and receipts.
- Split payments: one sale can be paid with cash, card and other together; change only comes out of cash.
- Fast-food orders: a token number that restarts each day, dine-in, takeaway and delivery, held orders, add-ons with their own price and cost, and one-tap payment.
- Delivery charge on delivery orders, counted as income and never as a menu item.
- Split a dine-in bill by items into separate bills, each with its own token.
- Kitchen board and tickets: only new items are sent, orders move through new, preparing, ready and served, and late orders turn red.
- Sales screen with totals by payment method, top products, recent sales, reprint and void.

**Knowing your numbers**
- Ingredients and recipes with real cost of goods from weighted-average purchase cost; food-cost percentage and margin per item; low-stock warnings.
- Purchases with supplier balances that can be paid down later.
- Running costs in categories you can extend; wastage valued at cost.
- Team and wages: clock in and out, monthly, daily or hourly pay, overtime, advances recovered at payroll, and payslips that can be paid from the till drawer.
- Money screen (owner only): profit and loss, where every rupee of sales went, break-even sales, per-item margins, busy hours, stock value and what you owe.
- Import and export of the menu as CSV, with a preview of every change before anything is saved.

**Running the shop safely**
- Staff PIN login with owner, manager and cashier roles. Permissions are enforced in the app's main process. PINs are salted hashes, wrong PINs lock the account for 30 seconds, and the till signs out after 5 idle minutes.
- Shifts with a cash float, cash in and out, a blind drawer count at close, and short, over or exact.
- Automatic daily backups, plus one after each shift closes; the newest 14 are kept next to the database.
- Shop settings: name, currency, number format, receipt width and footer.

**Installing and testing**
- Installers for Windows (x64 setup), macOS (Apple Silicon and Intel disk images) and Linux (AppImage and .deb), built by GitHub Actions when a version tag is pushed. A release is created as a draft, and an installer is only attached if the installed app passed its start-up check on that operating system.
- Continuous testing on Linux, Windows and macOS for every pull request: type check, unit tests, and a real launch of the app that walks through first-run setup.
- `npm run screenshots` rebuilds the screenshots in the README from a demo shop.

### Changed
- Node.js 22 or newer is now required. Node 20 reached end of life and the SQLite module no longer ships ready-made binaries for it.
- First-run install is more reliable: the Electron build of SQLite is downloaded ready-made and only compiled from source if that fails, and the data file location is printed at start-up.

### Known limitations
- The installers are not code-signed. Windows shows a SmartScreen warning and macOS asks you to approve the app on first open (see [docs/RELEASING.md](docs/RELEASING.md)).
- Tillbase is not approved for FBR, PRA or SRB tax-authority integration and must not be relied on for tax filing.
- New installs start in US dollars until you change the currency in Settings.
- There is no automatic updater: install a newer version over the old one and your data is kept.

[0.4.0]: https://github.com/mrbrown098/tillbase/releases/tag/v0.4.0
