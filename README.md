# Tillbase

Free, open source, offline-first point of sale for shops, supermarkets, malls and restaurants.

> **Status: early development (v0.4).** Tillbase is growing from a till into a full business suite for shops, cafes and fast-food restaurants: selling, orders and kitchen, stock and recipes, purchases, running costs, staff wages, and a profit-and-loss screen that answers "are we making money, and where is it going?". Everything below is built and tested. Multi-branch, customers/loyalty and direct thermal printing are still to come. See [docs/ROADMAP.md](docs/ROADMAP.md) for the plan and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) if you want to contribute. **Not yet approved for FBR, PRA or SRB tax-authority integration.**

## Why Tillbase

- **Free forever.** MIT licensed. Use it, change it, sell services around it.
- **Offline-first.** Everything runs on a local SQLite database, so the till keeps selling when the internet drops.
- **Correct money.** All amounts are integers in minor units (cents, paisa). No floating point rounding bugs.
- **Auditable stock.** Stock is a log of movements, never an overwritten number.
- **Safe checkout.** A sale is one database transaction: if anything fails, nothing is saved.

## What it does

**Selling**
- **Checkout** for counter sales: barcode scanner or name search, quantities, line discounts, tax, cash or card, change due, receipts for 58mm and 80mm printers.
- **Orders** for fast-food and restaurants: daily token numbers, dine-in, takeaway and delivery, table or customer details, add-ons such as extra cheese (with their own price and ingredient cost), several orders held open at once, paid in one tap. Every edit is saved immediately.
- **Kitchen** board and tickets: only new items are sent, and orders move new, preparing, ready, served. Late orders turn red. Only a manager can change or cancel food already in the kitchen.

**Knowing your numbers**
- **Menu and stock:** menu items and ingredients with units. A recipe gives each dish a real cost from what you actually paid (weighted-average cost), and selling a dish uses up its ingredients. Food-cost percentage and margin per item.
- **Purchases:** record what you buy and what you still owe suppliers; pay it down later.
- **Running costs:** rent, electricity, gas and more, in categories you can extend. Wastage (waste, spoilage, expiry) is valued at cost.
- **Team and wages:** clock in and out; monthly, daily or hourly pay with overtime; advances recovered at payroll; payslips paid from the till drawer if you like.
- **Money (owner only):** profit or loss, where every rupee of sales went, break-even sales, per-item margins, busy hours, stock value and what you owe. It warns you when a number cannot be trusted, for example when an item has no cost.

**Running the shop safely**
- **Staff and roles:** PIN login, owner, manager and cashier roles, enforced in the app's main process and not just hidden in the screen. PINs are salted hashes, wrong PINs lock for 30 seconds, and the till signs out after 5 idle minutes.
- **Shifts:** open with a float, cash in and out, count the drawer blind, see short, over or exact. Business payments can come out of the drawer and are counted.
- **Backups:** a daily copy of your data, and another after each shift closes. The newest 14 are kept next to the database.
- Works fully offline. Data is one local SQLite file.

**Also in the core library (no screen yet):** CSV import and export of the product list, see [docs/csv-import-export.md](docs/csv-import-export.md).

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/mrbrown098/tillbase.git
cd tillbase
npm install
npm run app        # builds everything and opens the desktop app
```

### Running the tests

The database library is a native module, and Electron and plain Node need different builds of it. `npm run app` builds it for Electron. Switch it back to Node before running tests:

```bash
npm run rebuild:node
npm test
npm run typecheck
```

Using the core engine:

```ts
import {
  openDatabase, ProductService, InventoryService, SaleService, formatReceipt,
} from "@tillbase/core";

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

Tax rates are in basis points: `1800` means 18.00%.

## Roadmap

- [x] Core engine, desktop app, barcode checkout, receipts
- [x] Staff logins, roles, shifts and cash drawer reconciliation
- [x] Ingredients, recipes and real cost of goods; purchases; running costs; wastage
- [x] Attendance and payroll; profit and loss
- [x] Fast-food orders, add-ons and kitchen board
- [x] Daily backups
- [ ] Business mode switch (retail or restaurant) and small, privacy-respecting banner slots on non-critical screens
- [ ] Product CSV import and export screen
- [ ] Delivery fees, split bills, floor plan, combos
- [ ] Customers and loyalty
- [ ] Direct receipt printing (ESC/POS) and cash drawer kick
- [ ] Installers for Windows, macOS and Linux
- [ ] Multi-branch with sync when online
- [ ] Translations, including Urdu

The detailed plan is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Project layout

```
packages/
  core/      Business logic and SQLite schema (TypeScript, no UI)
  desktop/   Electron + React app that uses the core
```

## Contributing

Issues and pull requests are welcome. Read [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) first: it explains the rules the code follows. Run `npm test` and `npm run typecheck` before sending a change.

## License

[MIT](LICENSE)
