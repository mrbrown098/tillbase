# Tillbase

Free, open source, offline-first point of sale for shops, supermarkets, malls and restaurants.

> **Status: early development (v0.1).** The core engine works and is tested. The desktop app is not built yet. See the roadmap below.

## Why Tillbase

- **Free forever.** MIT licensed. Use it, change it, sell services around it.
- **Offline-first.** Everything runs on a local SQLite database, so the till keeps selling when the internet drops.
- **Correct money.** All amounts are integers in minor units (cents, paisa). No floating point rounding bugs.
- **Auditable stock.** Stock is a log of movements, never an overwritten number.
- **Safe checkout.** A sale is one database transaction: if anything fails, nothing is saved.

## What works today

The `@tillbase/core` package:

- Products with barcode, SKU, cost, price and per-product tax rate
- Barcode lookup and name/SKU/barcode search
- Stock tracking, manual adjustments and low-stock list
- Checkout with line discounts, tax, split payments (cash, card, other) and change
- Overselling protection, with an opt-in override
- Sequential receipt numbers
- Voiding a sale, which restores stock
- Sales summary by period and payment method, with top products
- Plain-text receipts for 58mm and 80mm thermal printers

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/mrbrown098/tillbase.git
cd tillbase
npm install
npm test
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

- [x] Core engine: products, stock, sales, payments, reports, receipts
- [ ] Desktop app (Electron + React): checkout screen, barcode scanning, product and stock screens
- [ ] Users, roles and shift/cash drawer management
- [ ] Receipt printing (ESC/POS thermal printers) and cash drawer kick
- [ ] Restaurant mode: tables, kitchen orders, split bills
- [ ] Customers and loyalty
- [ ] Purchasing and suppliers
- [ ] Multi-branch with sync when online
- [ ] Data import/export (CSV)
- [ ] Translations

## Project layout

```
packages/
  core/    Business logic and SQLite schema (TypeScript)
```

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run typecheck` before sending a change.

## License

[MIT](LICENSE)
