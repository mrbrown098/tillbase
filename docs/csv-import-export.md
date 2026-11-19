# Importing and exporting your product list

Tillbase can read a product list from a spreadsheet and write one back out. This is
how a shop moves over from another till without typing thousands of products by hand,
and how you keep a copy of your catalogue outside the app.

Everything here lives in `@tillbase/core` and works offline.

## The columns

Only `name` and `price` are needed for a new product. Everything else is optional.

| Column | Meaning | Example |
|---|---|---|
| `name` | What appears on the till and the receipt | `Milk 1L` |
| `sku` | Your own code for the item | `MILK-1` |
| `barcode` | The number the scanner reads | `6001234500017` |
| `category` | Group name. Created automatically if it is new | `Dairy` |
| `price` | Selling price, as a normal decimal | `250.00` |
| `cost` | What you pay for it | `200.00` |
| `tax_percent` | Sales tax as a percentage, not basis points | `18` |
| `track_stock` | `yes` or `no` | `yes` |
| `reorder_level` | Warn me at or below this much stock | `12` |
| `opening_stock` | How many you have right now | `24` |
| `active` | `no` hides it from the till without deleting it | `yes` |

`ProductCsvService.templateCsv()` returns this header with two filled-in example rows.

Money is written as rupees, not paisa: `250.00`, never `25000`. Tax is written as `18`,
not `1800`. The engine still stores integers in minor units and basis points; the
conversion happens at the edge, so a spreadsheet never shows a floating point artefact.

### Headings from other systems

Headings are matched ignoring case, spacing, punctuation and anything in brackets, so
these all work without editing the file:

- `Item Name`, `Product`, `Description` → name
- `Item Code`, `Code`, `Article` → sku
- `EAN`, `UPC`, `GTIN` → barcode
- `Sale Price (PKR)`, `Retail Price`, `MRP`, `Rate` → price
- `Cost Price`, `Purchase Price` → cost
- `GST %`, `VAT`, `Tax Rate` → tax_percent
- `Qty`, `Quantity`, `On Hand`, `Stock` → opening_stock

Anything it does not recognise is ignored with a warning, so an export from your old
till can carry extra columns you do not need.

Callers that already think in minor units can use `price_minor`, `cost_minor` and
`tax_rate_bp` instead, which are read as whole integers.

### Separators and decimal commas

Comma, semicolon, tab and pipe separated files are all detected from the header line.
Excel writes semicolons in much of Europe and South Asia; in those files a comma is
the decimal separator, so `1.250,50` is read as 1250.50. That is assumed automatically
for semicolon files and can be forced either way with `decimalComma`.

Amounts may carry currency symbols and thousands separators: `Rs 1,250`, `₨ 250.5`
and `PKR 99.99` all read correctly.

## Checking before committing

Always preview first. A dry run reads and validates the whole file, reports exactly
what would happen, and writes nothing at all:

```ts
import { openDatabase, ProductCsvService } from "@tillbase/core";

const catalog = new ProductCsvService(openDatabase("shop.sqlite"));

const preview = catalog.importCsv(fileText, { dryRun: true });
console.log(preview.created, preview.updated, preview.skipped, preview.failed);
for (const issue of preview.issues) {
  console.log(`row ${issue.row} ${issue.column ?? ""}: ${issue.message}`);
}

if (preview.failed === 0) catalog.importCsv(fileText);
```

Each issue carries a row number (the header is row 1), the column heading, and a
message written for a shop owner rather than a programmer. Warnings do not block an
import; errors do.

By default **one bad row means nothing is saved**, so a half-imported catalogue never
happens. Pass `onError: "skip"` to save the good rows and report the rest.

## How rows are matched to existing products

In order: `id` (only present in a Tillbase export), then `sku`, then `barcode`, then the
exact `name`. Inactive products are matched too, so an import can bring one back.

- A match is **updated**. Only the columns present in the file are changed.
- **A blank cell means "leave this alone"**, never "erase". A price list with just
  `sku,price` will not wipe your barcodes, costs or categories.
- No match means a **new product**, which needs a name and a price.
- An `id` that does not exist here is a hint, not a demand: it falls back to sku,
  barcode and name, and warns. That is what makes restoring an export into a fresh
  installation work.
- Two rows in the same file pointing at one product is an error, so stock is never
  applied twice.

Set `updateExisting: false` to only add new products, or `matchOnName: false` if your
product names repeat and only codes should be trusted.

## Stock is a log, not a number

Tillbase never overwrites a stock figure. An import writes movements, exactly as a
person doing a stock count would:

- A **new** product with `opening_stock` gets one `opening stock` movement.
- An **existing** product's stock is **left alone by default**. Re-importing a price
  list must not undo a day of trading.
- With `stockMode: "set"`, the difference is added as a `stock count` movement. If the
  file says 30 and the shelf says 24, the log gets `+6`, not a silent replacement.
  Counting down works the same way, and a matching count writes nothing.
- Products with `track_stock: no` never get stock movements.

Fractional quantities (kg, litres) are supported and rounded to six decimal places so
float noise never reaches the log.

## Exporting

```ts
const csv = catalog.exportCsv({ includeInactive: true, includeIds: true, bom: true });
```

- `includeIds` adds the internal id column, so re-importing your own export updates
  rather than duplicates.
- `includeInactive` keeps retired products in the file. They are left out by default.
- `bom` adds a UTF-8 mark so Excel shows Urdu and other non-ASCII names correctly.
- `includeStock: false` drops the stock column, for a pure price list.
- `escapeFormulas` prefixes cells starting with `=`, `+`, `-` or `@` with an apostrophe,
  so a product name cannot be run as a formula by a spreadsheet. Off by default so
  export and import stay exact opposites; turn it on for files you hand to other people.

Export then import is a round trip: names, codes, prices, costs, tax, stock flags,
reorder levels, categories and stock levels all come back unchanged, including names
containing commas, quotes or line breaks.

## A note for whoever wires up the screen

This change is deliberately core-only, so it does not touch the desktop app while
other work is in flight there. The screen still needs:

1. `listItems`-style handlers in `electron/handlers.ts` calling `exportCsv` and
   `importCsv`, guarded by the existing product permission.
2. A file open/save dialog in the main process; the renderer should never touch the
   filesystem directly.
3. A preview table showing `created / updated / skipped / failed` and the issue list,
   with a confirm button that re-runs the import with `dryRun: false`.

Suggested flow: pick file → dry run → show the plan and every issue → confirm → import.
Never import on file selection alone.
