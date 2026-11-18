# Tillbase

Free, open source, offline-first point of sale for shops, supermarkets, malls and restaurants.

> **Status: early development (v0.2).** The core engine and a first desktop app (checkout, products, stock, sales, settings) work and are tested. Restaurant mode, users/roles and multi-branch are still to come. See the roadmap below.

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

## What the desktop app does

- **Checkout:** scan a barcode (USB scanners work like a keyboard) or search by name, tap products, change quantities, add a per-line discount, take cash or card, show change due, print the receipt.
- **Products:** add and edit products, tax rate, cost, barcode, reorder level and opening stock; adjust stock with a reason; low-stock highlighting.
- **Sales:** today's totals by payment method, top products, recent sales, reprint receipts, void a sale (stock is restored).
- **Settings:** store name, currency, number format, receipt width and footer.
- Works fully offline. Data is stored in a local SQLite file.

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

- [x] Core engine: products, stock, sales, payments, reports, receipts
- [x] Desktop app (Electron + React): checkout, barcode scanning, products, stock, sales, settings
- [ ] Split payments in the checkout screen (the core already supports them)
- [ ] Users, roles and shift/cash drawer management
- [ ] Direct receipt printing (ESC/POS thermal printers) and cash drawer kick. Today receipts print through the system print dialog.
- [ ] Installers for Windows, macOS and Linux
- [ ] Restaurant mode: tables, kitchen orders, split bills
- [ ] Customers and loyalty
- [ ] Purchasing and suppliers
- [ ] Multi-branch with sync when online
- [ ] Data import/export (CSV)
- [ ] Translations

## Project layout

```
packages/
  core/      Business logic and SQLite schema (TypeScript, no UI)
  desktop/   Electron + React app that uses the core
```

## Contributing

Issues and pull requests are welcome. Run `npm test` and `npm run typecheck` before sending a change.

## License

[MIT](LICENSE)
