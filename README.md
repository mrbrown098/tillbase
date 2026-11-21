# Tillbase

**A free, open-source business suite for shops, restaurants and fast-food outlets. Not just a till.**

Sell, take orders, run the kitchen, track stock and recipes, record purchases and costs, pay your staff, and see in one screen whether the business is making money and where it is going. It runs on your own computer, works without the internet, and costs nothing. No subscription, no per-user or per-branch fees.

> **Status: early development (v0.4).** Everything listed under "What it does" is built and tested. Installers, an Urdu interface and multi-branch are still to come (see [Roadmap](#roadmap)). **Tillbase is not yet approved for FBR, PRA or SRB tax-authority integration.** Do not rely on it for tax filing until that exists.

## Why Tillbase

- **A business suite, not only a POS.** Most free tills stop at "ring up a sale". Tillbase also answers the owner's real questions: *what does each dish cost me, what did I spend, what did I pay my staff, am I making a profit, and where is the money going?*
- **For every kind of business.** A grocery, a clothes shop, a pharmacy, a cafe or a fast-food restaurant all use the same engine. Retail shops use the checkout and stock; food businesses add recipes, orders and the kitchen.
- **Free forever.** MIT licensed. No subscription, no setup fee, no limit on terminals or staff. The only money-making idea in the project is a few short, clearly labelled sponsor banners on non-critical screens (planned): never at checkout, payment or login, with no tracking and no third-party scripts.
- **Your data stays with you.** One local SQLite file on your own computer, with automatic daily backups. It keeps working when the internet drops.
- **Numbers you can trust.** Money is stored as whole numbers (paisa/cents), never floating point. Stock is a log of movements, never an overwritten number. A sale is one database transaction, so a crash never leaves half a sale behind. When a figure may be wrong (a dish with no cost, wages not yet run), the screen says so instead of looking confident.
- **Built to be checked.** Over 200 automated tests, and the screens are driven end to end in a real Electron window.

## What it does

**Selling**
- **Checkout** for counter sales: scan a barcode or search, change quantities, line discounts, tax, cash or card, change due, receipts for 58mm and 80mm printers. **Split payments:** one sale can be paid with cash, card and other together (the screen shows what is remaining, and change only comes out of cash). Exact cash or card is still one tap.
- **Orders** for fast-food and restaurants: a token number that restarts each day, dine-in, takeaway and delivery, table or customer details, add-ons such as extra cheese (with their own price and ingredient cost), several orders held open at once, paid in one tap. Delivery orders can carry a delivery charge, which is shown before payment and counted as income. A dine-in group can **split the bill by items** into separate bills, each with its own token, and pay separately. Every edit is saved immediately.
- **Kitchen** board and tickets: only new items are sent; orders move new, preparing, ready, served; late orders turn red. Only a manager can change or cancel food already in the kitchen.
- **Sales:** today's totals by payment method, top products, recent sales, reprint, void (stock is restored exactly).

**Knowing your numbers**
- **Menu and stock:** menu items and ingredients with units. A recipe gives each dish a real cost from what you actually paid (weighted-average cost), and selling a dish uses up its ingredients. Food-cost percentage and margin per item. Low-stock warnings.
- **Purchases:** record what you buy and what you still owe each supplier, and pay it down later.
- **Running costs:** rent, electricity, gas and more, in categories you can extend. Wastage (waste, spoilage, expiry, damage) is valued at cost.
- **Team and wages:** clock in and out; monthly, daily or hourly pay with overtime; advances recovered at payroll; payslips paid from the till drawer if you like.
- **Money (owner only):** profit or loss, where every rupee of sales went (ingredients, waste, wages, running costs, profit), break-even sales, per-item margins, busy hours, stock value and what you owe.
- **Import / export** of the menu as CSV, with a preview of every change before anything is saved ([guide](docs/csv-import-export.md)).

**Running the shop safely**
- **Staff and roles:** PIN login with owner, manager and cashier roles. Permissions are enforced in the app's main process, not just hidden in the screen. PINs are salted hashes, wrong PINs lock the account for 30 seconds, and the till signs out after 5 idle minutes. Profit and payroll are owner-only.
- **Shifts:** open with a cash float, record cash in and out, count the drawer blind at close, see short, over or exact. Business payments taken from the drawer are counted.
- **Backups:** a daily copy of your data, and another after each shift closes. The newest 14 are kept next to the database.
- **Settings:** store name, currency, number format, receipt width and footer.

## Being built right now

| Work | What |
|---|---|
| Installers and CI | Windows, macOS and Linux installers on GitHub Releases, and automatic tests on all three systems |
| Business mode and sponsors | Retail / restaurant mode switch, first-run guide, sponsor banner slots |

## Up next

In rough priority order (details in [docs/ROADMAP.md](docs/ROADMAP.md)):

1. First-run setup that asks for currency and country (a new install currently starts in US dollars).
2. **Business-day cutoff**, so a restaurant open past midnight keeps one day's tokens and profit together.
3. Urdu interface and Urdu on receipts.
4. Backups to a second place (USB or a synced folder), not only next to the database.
5. Reports for the accountant (CSV and printable), and Money-screen export.
6. Direct thermal printing (ESC/POS), cash drawer kick, silent printing.
7. Customers, loyalty and a wallet; dual tax rates for cash and card.
8. Purchase orders, expiry tracking, supplier statements, recurring expenses.
9. Several terminals on one network, then multi-branch with sync.

## Quick start

Requires **Node.js 22 or newer** (check with `node --version`; Node 20 is end-of-life and the SQLite module no longer ships ready-made binaries for it). (Ready-made installers are being built; until then, run it from source.)

```bash
git clone https://github.com/mrbrown098/tillbase.git
cd tillbase
npm install
npm run app        # prepares SQLite for Electron, builds everything, opens the app
```

The first run takes a minute, then Tillbase asks you to create the owner account. If it does not start, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

### Running the tests

SQLite is a native module, and Electron and plain Node need different builds of it. `npm run app` prepares the Electron build. Switch back to the Node build before running tests:

```bash
npm run rebuild:node
npm test
npm run typecheck
```

### Using the core engine on its own

`@tillbase/core` has no UI and can be used from any Node program:

```ts
import { openDatabase, ProductService, InventoryService, SaleService, formatReceipt } from "@tillbase/core";

const db = openDatabase("shop.sqlite");
const products = new ProductService(db);
const inventory = new InventoryService(db);
const sales = new SaleService(db, "T1");

const milk = products.create({ name: "Milk 1L", priceMinor: 250, barcode: "6001", taxRateBp: 1000 });
inventory.adjust(milk.id, 24, "purchase");

const sale = sales.checkout({
  lines: [{ productId: milk.id, qty: 2 }],
  payments: [{ method: "cash", amountMinor: 1000 }],
  cashier: "Ali",
});

console.log(formatReceipt(sale, { storeName: "Corner Shop" }));
```

Amounts are in minor units and tax rates in basis points: `1800` means 18.00%.

## Roadmap

- [x] Core engine, desktop app, barcode checkout, receipts
- [x] Staff logins, roles, shifts and cash drawer reconciliation
- [x] Ingredients, recipes and real cost of goods; purchases; running costs; wastage
- [x] Attendance and payroll; profit and loss
- [x] Fast-food orders, add-ons and kitchen board
- [x] Menu CSV import and export
- [x] Daily backups
- [x] Delivery fees, split payments, split bills
- [ ] Installers for Windows, macOS and Linux; CI on all three
- [ ] Business mode switch, first-run guide, sponsor banners
- [ ] First-run currency and country; business-day cutoff
- [ ] Urdu interface and receipts
- [ ] Off-site backups; accountant reports
- [ ] Direct thermal printing and cash drawer kick
- [ ] Customers and loyalty
- [ ] Multi-terminal and multi-branch with sync

## Project layout

```
packages/
  core/        @tillbase/core: all business logic and the SQLite schema (TypeScript, no UI)
    src/         sales, orders, products, recipes, inventory, purchases, expenses, labour,
                 finance (profit and loss), users, shifts, permissions, csv, backup, migrations
    test/        vitest tests
  desktop/     @tillbase/desktop: Electron + React app that uses the core
    electron/    main process: handlers.ts (the API and permission checks), main.ts, preload.ts, files.ts
    shared/      api.ts: the interface between screens and the main process
    renderer/    React screens, one file per screen
    scripts/     rebuild-native.mjs (prepares SQLite for Electron)
    test/        API and permission tests
docs/
  ROADMAP.md           plan, market position, compliance note
  DEVELOPMENT.md       the rules and workflow for contributors (read this first)
  TROUBLESHOOTING.md   if the app will not start
  csv-import-export.md the menu CSV format
```

## Contributing

Tillbase is built to be worked on by several people at once, so the rules are written down.

1. Read **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**. It is short and covers the rules the code follows (money, migrations, stock, permissions) and how to avoid conflicts.
2. Pick something from "Being built right now" or "Up next", and open an issue saying you are taking it so two people do not build the same thing.
3. Work on a branch `feature/<name>` from the latest `main`. Never push to `main`.
4. Add tests (hand-check the numbers when money is involved) and run the real app for anything with a screen.
5. Run `npm run rebuild:node && npm test && npm run typecheck`, rebase on `main`, and open a pull request that says what you tested and what you did not.

Be honest in code and in the UI: do not claim tax-authority approval, and do not hide a number that might be wrong.

## License

[MIT](LICENSE)
