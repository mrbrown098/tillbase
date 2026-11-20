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
| Orders, add-ons, kitchen | `orders.ts` | `Orders.tsx`, `Kitchen.tsx` |
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
