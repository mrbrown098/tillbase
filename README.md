# Tillbase

Free, open source, offline-first point of sale for shops, supermarkets, malls and restaurants.

> **Status: early development (v0.3).** The core engine and a desktop app (checkout, products, stock, sales, staff logins, shifts, settings) work and are tested. Restaurant mode, customers/loyalty and multi-branch are still to come. See [docs/ROADMAP.md](docs/ROADMAP.md) for the plan and how Tillbase compares with paid POS products. This is not yet certified for Pakistani tax-authority integration.

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

- **Staff and roles:** PIN login for each person, with owner, manager and cashier roles. Cashiers can sell; discounts, voids, cash in/out, stock and reports need a manager; staff and settings need an owner. PINs are stored as salted hashes, wrong PINs lock the account for 30 seconds, and the till signs out after 5 idle minutes. Permissions are enforced in the app's main process, not just hidden in the screen.
- **Shifts:** open with a cash float, record cash in and out, then count the drawer to close. The expected amount is hidden from cashiers until they close, so they count what is really there. Shows the difference as short, over or exact.
- **Checkout:** scan a barcode (USB scanners work like a keyboard) or search by name, tap products, change quantities, add a per-line discount, take cash or card, show change due, print the receipt.
- **Products:** add and edit products, tax rate, cost, barcode, reorder level and opening stock; adjust stock with a reason; low-stock highlighting.
- **Sales:** today's totals by payment method, top products, recent sales, reprint receipts, void a sale (stock is restored).
- **Settings:** store name, currency, number format, receipt width and footer.
- **Import and export menu items (CSV):** on the Menu and stock screen, bring a menu in from a spreadsheet or save a copy of it. You choose the file, see a preview of exactly what would be added, updated or skipped (with every problem row marked and explained), and only then confirm. Ingredients and recipes are not part of the file.
- Works fully offline. Data is stored in a local SQLite file.

## Quick start

### Download (no developer tools needed)

Get the installer for your computer from the [latest release](https://github.com/mrbrown098/tillbase/releases/latest) and run it:

| Computer | Download |
|---|---|
| Windows 10 or 11 | `Tillbase-<version>-win-x64-setup.exe` |
| Mac with Apple chip (M1 or newer) | `Tillbase-<version>-mac-arm64.dmg` |
| Mac with Intel chip | `Tillbase-<version>-mac-x64.dmg` |
| Linux | `Tillbase-<version>-linux-x86_64.AppImage`, or `Tillbase-<version>-linux-amd64.deb` for Ubuntu and Debian |

The installers are not code-signed yet, so Windows and macOS warn you the first time you open them. This is expected; [docs/RELEASING.md](docs/RELEASING.md#unsigned-builds-what-users-will-see) shows the exact clicks. Your data is kept in your user folder, not in the install folder, so updating (install the newer version over the old one) or uninstalling never deletes it.

### Run from source (developers)

Requires Node.js 20 or newer.

```bash
git clone https://github.com/mrbrown098/tillbase.git
cd tillbase
npm install
npm run app        # prepares SQLite for Electron, builds everything, opens the app
```

The first run takes a minute. If it does not start, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

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
- [x] Staff PIN login, roles and permissions; shifts with cash drawer reconciliation
- [ ] Direct receipt printing (ESC/POS thermal printers) and cash drawer kick. Today receipts print through the system print dialog.
- [ ] Installers for Windows, macOS and Linux
- [ ] Restaurant mode: tables, kitchen orders, split bills
- [ ] Customers and loyalty
- [ ] Purchasing and suppliers
- [ ] Multi-branch with sync when online
- [x] Data import/export (CSV) of menu items. Ingredients and recipes are not included yet.
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
