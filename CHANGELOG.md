# Changelog

All notable changes to Tillbase are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Backups to a second place: the owner can choose a USB drive or a Dropbox or Google Drive folder on the new Backups screen, and every backup is copied there too. A missing folder never stops selling; it shows a plain warning.
- Restore from a backup (owner only): the backup is checked first, the current data is kept as `tillbase.sqlite.before-restore`, and Tillbase restarts on the restored data.

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
