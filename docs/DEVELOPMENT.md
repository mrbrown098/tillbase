# Developing Tillbase

Read this before changing anything. It is short on purpose.

## Layout

```
packages/core      @tillbase/core: all business logic and the SQLite schema. No UI, no Electron.
packages/desktop   @tillbase/desktop: Electron app
  electron/        main process: handlers.ts (the API), main.ts, preload.ts
  shared/api.ts    the TillbaseApi interface and the `channels` list
  renderer/src/    React screens (one file per screen)
```

Data flow: a screen calls `api.something()` -> preload -> IPC -> `createHandlers` in `electron/handlers.ts` -> a service in `@tillbase/core`. Handlers check permissions and open-shift rules; services hold the rules about money and stock.

## Rules that must not be broken

1. **Money is an integer in minor units** (paisa, cents). Tax rates are basis points (1800 = 18%). Never use floating point for money. Quantities and `avg_cost` are REAL by design.
2. **Migrations are append-only.** Add a new entry at the end of `packages/core/src/migrations.ts` with the next version number. Never edit or reorder an old one. Add a test that upgrades a database from the previous version with real data.
3. **Stock is a log.** Never overwrite a quantity. Write a `stock_movements` row (with `value_minor` for cost). Voids reverse the original movements exactly.
4. **Sales go through `SaleService.checkout`.** Anything that sells (orders, future features) calls it so stock, cost of goods and profit stay correct.
5. **Permissions are enforced in `handlers.ts`**, never only in the UI. New permissions go in `permissions.ts`. Owner-only things (profit, payroll, settings, staff) stay owner-only.
6. **A new API method needs three edits:** the method in `TillbaseApi` and the name in `channels` (both in `shared/api.ts`), and the implementation in `handlers.ts`. Forgetting `channels` means the screen cannot call it.
7. **Be honest in the UI.** If a number may be wrong (missing cost, estimated wages) the screen must say so. Do not claim tax-authority approval.
8. **Services throw `Error` with a plain message safe to show a cashier.**
9. Prefer plain, kind wording on screens: this is used by shop and restaurant staff, not accountants.
10. **Hidden system products.** `products.is_system = 1` marks a product the app makes for itself (today only the "Delivery fee" line on a sale). It must never appear in a list, search, barcode lookup, stock or low-stock view, CSV export or import match, or best-sellers, and it must not raise the "item has no cost" warning. Any new query over `products` that people see or match against needs `is_system = 0`; the delivery-fee test in `packages/core/test/orders.test.ts` checks each place, so extend it when you add one.
11. **Split bills share their table.** Orders made by `splitItems` carry `split_from`; the one-open-order-per-table rule treats orders from the same split chain as one family. Splitting never changes a price or removes an item, and a delivery charge stays on the original bill.
12. **Customer balances come from a ledger.** `customers.points` and `customers.wallet_minor` are never written by code: database triggers add up `customer_ledger` rows, and the ledger cannot be updated or deleted. Change a balance only with `postLedger` (in `customers.ts`) inside the transaction that needs it, and fix mistakes with a correcting row. A voided sale reverses its own rows (`reverseSaleLedger`). Points discount only the food lines (never a hidden system line such as the delivery fee) and are shared across lines with `allocateDiscount` before tax; the till screen uses the same function from `@tillbase/core/discount`. Wallet money is a `payments` row with method `other` and label `wallet`. Spend totals are for the owner only: `customerHistory` returns `null` unless the user has `customers.view_spend`.
13. **Khata is a ledger account, not a payment.** What a customer owes is the sum of their `account = 'credit'` rows in `customer_ledger` (positive = owes the shop). Never store it. A sale on account puts `sales.on_account_minor` on the sale and a `credit_sale` row on the ledger; it is income, but it is **not** a `payments` row, so it never reaches `paid_minor`, the drawer, or the by-method totals. Repayments (`repay`) and write-offs go through `CustomerService`; a cash repayment is also a cash-in on the open shift (done in the handler, in one transaction). Voids reverse the account rows with `reverseSaleLedger`. Anything that adds up money received must keep ignoring `on_account_minor`; anything that adds up income already includes it.
14. **Printing never blocks a sale.** `escpos.ts` (core) only turns text and pictures into bytes: it has no network and no Electron, and its golden-byte tests are the reference. Sending (TCP port 9100, 3-second timeout) and decoding the shop logo live in `electron/printing.ts`. A `print*` API method **never throws for printer trouble**: it returns `{status: "printed"}`, `{status: "no_printer"}` (none set up: the screen uses `window.print()`) or `{status: "failed", message}` (plain words, shown with "Print again"). The printer address is stored under `printer.*` keys in the `settings` table by `PrinterConfigService`, not in `ShopSettings`. Paper size follows `receiptWidth` (32 = 58 mm, 48 = 80 mm). Text is sent in the PC437 code page: accents are dropped and unknown characters print as `?` (see `encodeText`). The renderer uses `usePrinting()` in `printing.tsx` for every print button.
15. **The business profile only decides what is shown.** `business.ts` (core) holds the profiles (retail, restaurant, fast food, pharmacy, custom), the country list and `BusinessProfileService`, which keeps its answers under `business.*` keys in the `settings` table (no migration). A profile hides menu parts (`optionalModules`), offers certain order types and picks the Home buttons; it never grants or removes a permission (`can()` and `authorize()` still decide) and never deletes data. An installation with no `business.status` key is **`legacy`**: it is never sent through the wizard and keeps showing everything. The first-run wizard (`Onboarding.tsx`) creates the owner with `beginOnboarding` (owner + `in_progress` in one transaction), saves every step as it goes, and resumes at the saved step after an interruption; step numbers are stored, so never renumber `STEP`. Be honest in a profile: `available` lists only what is built and tested, `notYet` lists the rest (the pharmacy profile must never claim batches, expiry, prescriptions or a controlled-medicine register; a test checks this). Never suggest or assume a tax rate or a tax-authority approval: the owner types the rate. The business-day cutoff and time zone are only stored for now (reports still use the computer's calendar day), and the screens say so.
16. **Payment methods and repeated checkouts.** `payments.method` is `cash`, `card`, `bank_transfer` or `other` (migration v10). A bank transfer is money received but never cash in the drawer, so it never changes a shift's expected cash; it cannot give change, and its optional `reference` (a transaction number, at most 80 characters) is kept on the payment. `SalePaymentMethod` lists all four; `PaymentMethod` is the older three-way type that screens may still use. Every screen that rings up a sale should send a `requestId` (a new UUID for each attempt, not each click): `SaleService.checkout` returns the sale already saved under that id instead of selling again, and a unique index on `sales.request_id` backs this up in the database.
17. **Refunds are their own records.** A refund (`refunds`, `refund_items`, migration v11) is dated when it is made and never edits the sale, its shift or its stock movements; the tables cannot be updated or deleted. Manager or owner (`refund` permission), a reason is required, and it needs an open shift. Amounts are shared out by `cumulative()` in `refunds.ts`, so several part-refunds of a line add up to the line exactly. With `restock` the stock comes back at the cost it was sold at, read from the line's own movements (`stock_movements.sale_item_id`; sales from before v11 are linked only when they are simple, otherwise restock is refused). Cash refunds take money from the **open** drawer as a cash movement (`ref_type = 'refund'`); other methods are only recorded. **A closed shift never changes**: refunds and voids made later land in the shift open at that time, and `ShiftService.summary` of a closed shift keeps counting a sale voided after the shift closed. A sale that has a refund cannot be voided, and sales paid with khata, wallet or points cannot be part-refunded (void them). Profit and loss takes refunds off the day they were made; the cost of goods comes off only when restocked.

## Running things

```bash
npm install
npm run rebuild:node       # native SQLite build for Node (needed before tests)
npm test                   # core + desktop tests
npm run typecheck
npm run build -w @tillbase/core   # the desktop package reads core from dist/, rebuild after changing core
npm run app                # prepare SQLite for Electron, build everything, open the app
```

`better-sqlite3` is a native module and Electron and plain Node need different builds. `npm run rebuild -w @tillbase/desktop` (also run by `npm run app`) downloads the prebuilt Electron binary, and compiles from source only if that fails. After running the app, run `npm run rebuild:node` before tests.

## Testing standard

- Every core rule gets a vitest test. For anything with money, compute the expected numbers by hand in a comment and assert them, instead of copying the code's output.
- Handler tests (`packages/desktop/test`) cover permissions and the API.
- For screens, drive the real app with Playwright's Electron support under `xvfb-run` and check what the user sees. Set `TILLBASE_DB` to a throwaway file. Keep e2e scripts outside the repo unless you add a proper test folder.
- Do not claim something works unless it ran.

## Git workflow

- One feature per branch, `feature/<short-name>`, branched from the latest `main`. Never push to `main`.
- Small commits with a clear message. Open a pull request into `main`; the owner reviews and merges.
- **Avoid conflicts:** these files are touched by almost every feature, so keep edits there small and additive (append, do not reorder): `migrations.ts`, `core/src/index.ts`, `shared/api.ts`, `handlers.ts`, `App.tsx`, `styles.css`, `README.md`, `docs/ROADMAP.md`. Put new logic in a new file.
- Rebase on `main` before you open the pull request, and rerun the tests after.
- If two people need the same migration number, the second one renumbers after the first merges.

## Where things are

| Area | Core | Screen |
|---|---|---|
| Selling | `sales.ts`, `receipt.ts` | `Checkout.tsx`, `Sales.tsx` |
| Orders, add-ons, kitchen, delivery fee, split bills | `orders.ts` | `Orders.tsx`, `Kitchen.tsx` |
| Customers, loyalty points, wallet | `customers.ts`, `discount.ts` | `Customers.tsx`, `CustomerPicker.tsx`, `loyalty.ts` |
| Direct thermal printing, cash drawer | `escpos.ts`, `printer.ts` | `printing.tsx`, `PrinterSettings.tsx` (sender and logo: `electron/printing.ts`) |
| First-run setup, business profile | `business.ts` | `Onboarding.tsx`, `BusinessProfileSettings.tsx` (menu: `App.tsx`, buttons: `Home.tsx`) |
| Pay screen (several payments) | `sales.ts` | `Checkout.tsx` (`PayModal`), `payments.ts` |
| Products, recipes, stock | `products.ts`, `recipes.ts`, `inventory.ts` | `Products.tsx` |
| Purchases, expenses | `purchases.ts`, `expenses.ts` | `Purchases.tsx`, `Costs.tsx` |
| Wages | `labour.ts` | `Team.tsx` |
| Profit and loss | `finance.ts` | `Money.tsx` |
| Staff, shifts | `users.ts`, `shifts.ts`, `permissions.ts` | `Staff.tsx`, `Shift.tsx`, `Login.tsx` |
| CSV | `csv.ts`, `product-csv.ts` | `ImportExport.tsx` (native dialogs in `electron/files.ts`) |
| Backups | `backup.ts` | `main.ts` |

## Test-only switches

`TILLBASE_DB=/path/file.sqlite` points the app at a throwaway database. `TILLBASE_TEST_CSV_OPEN` and
`TILLBASE_TEST_CSV_SAVE` skip the native CSV file windows so an automated run can use the screen; they are
read only by the main process and ignored in a packaged app.

## Known gaps worth fixing (from the project audit)

- `stock_movements` has no index on `ref_id` or `created_at`: voids and the wastage report will slow down with years of data (add one in a new migration).
- Tokens and "today" use the calendar day; a business-day cutoff hour is needed for places open past midnight.
- A fresh install defaults to USD and never asks for a currency.
- Backups are stored next to the database only.
