# Changelog

All notable changes to Tillbase are listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-11-22

A big usability release: a guided first-run setup with business profiles, a new Home screen and menu, shop logos, customer credit (khata), supplier orders, direct receipt printing, and an optional sponsor line and update notice. Existing shop data is upgraded automatically (database migrations 7 to 9); a backup is taken at start-up, as always.

### Added
- **Reports** (the Money tab, owners only): Today, Yesterday, This week (Monday to today), This month or any dates. Sales, cost of goods, gross and net profit with every step of the calculation shown, payment methods, best sellers and slow movers, stock value and low stock, expenses by category, supplier and customer balances, and staff and shift performance. Charts for sales and gross profit over time, busy hours, payment methods, expenses, best sellers and stock. Everything comes from your own records; where a cost is missing or wages are estimated, the screen and the printout say so.
- **A4 reports**: Daily and monthly sales, profit and loss, expenses, stock, product performance, staff and shifts, and customer and supplier statements. Preview them, **Print** (opens the A4 PDF in your PDF viewer) or **Save as PDF**. Each has the shop name and logo, the dates, when it was made, and "Powered by Tillbase" with the page number on every page.
- Real-app check `scripts/e2e-reports.mjs` (also in CI): compares the sales figure on screen with the database, makes every report as a PDF and checks A4 size and the footer on each page.
- Sponsor banner: one slim, clearly labelled line at the bottom of the Home screen, read from the public `ads/manifest.json`. Text and a small still picture only, never at checkout, payment or login, nothing about the shop is sent, and it disappears when offline or when there is no sponsor. Owners can turn it off in Settings (`TILLBASE_NO_ADS=1` turns it off for a whole machine). Outside ad networks stay disabled; see `docs/ADS-PROVIDERS.md`.
- Update notice: the owner sees "Tillbase X is available" on Home when a newer stable release exists, with What is new, Remind me later and Update now (opens the official download page; nothing is installed silently and a sale is never interrupted). Settings shows the version and a Check for updates button. Works offline (it just shows nothing) and backs off if GitHub rate-limits.
- Supplier orders: place an order with a supplier, receive it in one or several deliveries (each delivery is booked as a normal purchase, so stock, average cost and what you owe update), cancel it, and see a supplier statement of purchases and payments.
- **Direct receipt printing.** Tillbase can now send receipts, kitchen tickets and customer statements straight to a network receipt printer (58 mm or 80 mm), with no print window. Your shop logo prints above the receipt, and the "Powered by Tillbase" footer is included. A receipt prints by itself when a sale is finished, and a kitchen ticket when an order is sent to the kitchen. The printer can also open the cash drawer when a sale includes cash. If the printer is switched off or unreachable the sale is still saved: a clear message appears with **Print again**, or you can use this computer's print window instead. With no printer address set, everything works as before.
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
- Database migration 9 (credit limit and account entries on the customer ledger; migration 7 is the PIN length, migration 8 is supplier purchase orders).
- **First-run setup.** A new installation now opens a guided setup: a welcome screen, creating the owner account, country (which suggests the currency and number format, both changeable), the kind of business, shop details, whether you add tax, your first staff, and an optional receipt printer, then a review. If you close the app part-way, setup resumes where you stopped. Shops already using Tillbase are not sent through it: nothing changes for them, and the owner can run setup later from Settings.
- **Business profiles.** Pick Retail shop (grocery, general or clothing), Restaurant, Fast food, Pharmacy or Custom. The profile chooses which parts of the menu are shown (for example Orders and Kitchen for food businesses), the order types offered, what the Products tab is called, and which shortcuts Home shows. Custom lets you switch each part on or off. The owner can change the profile and the visible parts later in Settings. A profile only decides what is shown: it never removes data, and permissions are enforced as before.
- **Pharmacy is a starting point only, not a pharmacy system.** The Pharmacy profile gives you checkout, stock counts with low-stock alerts, purchases and supplier orders, and khata, like a shop. It has no batch or lot numbers, no expiry dates or expiry alerts, does not stop an expired medicine being sold, and has no prescription records or controlled-medicine register. The app says this on the profile and in setup. You stay responsible for compliance with your local pharmacy rules.

### Changed
- "Powered by Tillbase" is now permanent on everything Tillbase prints (58 mm and 80 mm receipts, kitchen tickets, statements, A4 reports). The Settings switch for it is gone, and an old saved value is ignored. The shop's own receipt message is separate and unchanged.

### Fixed
- The sign-in screen now shows exactly as many empty boxes as your PIN has digits (so an 8-digit PIN shows 8 boxes) and signs you in on the last digit. Accounts made earlier learn their length the first time they sign in.
- Installing from source with npm 11.2x and newer no longer leaves Electron without its program file ("Electron failed to install correctly"): the packages that need their install step (Electron, esbuild, SQLite) are now approved in `package.json`.
- Installing from source with a recent npm (11 and newer) no longer fails with `EALLOWGIT`: a build tool that was fetched over git/SSH is now taken from the normal npm registry.

### Known limitations
- Pharmacy has no batches, expiry tracking, expired-stock blocking, prescription records or controlled-medicine register (see above).
- The "do you trade after midnight" answer in setup is saved, but Home and reports still count calendar days (midnight to midnight). Applying it is planned.
- Tillbase does not choose a tax rate for you and is not approved for FBR, PRA or SRB tax-authority integration.
- Direct receipt printing works for network (Ethernet or Wi-Fi) printers only.
- The installers are not code-signed, and updates are installed by hand: the update notice only opens the download page.

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
