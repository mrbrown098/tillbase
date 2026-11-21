# Tillbase roadmap and market position

This document says where Tillbase is going and why. It separates what is built from what is planned, and it does not claim anything we have not shipped and tested.

## The market gap

Commercial POS products in Pakistan are sold as monthly subscriptions per branch, with the useful parts behind higher tiers and add-ons. One example, from the vendor's own public pricing page (read November 2026, [granetpro.com/pricing](https://www.granetpro.com/pricing.html)):

| | Granet Pro (public pricing) | Tillbase |
|---|---|---|
| Price | PKR 2,999 / 5,999 / 9,999 per month per branch | Free, MIT licensed |
| Inventory, recipes, COGS | Growth plan and above | Included |
| Kitchen display, HR/payroll, supplier ledger, financials | Pro plan only | Planned, included |
| Extra terminal / extra user beyond 5 | PKR 1,000 / PKR 500 per month each | Unlimited |
| Tax-authority compliance | PKR 2,000 per month add-on | Planned, free (see the compliance note) |
| Multi-branch | Listed as "coming soon" | Planned |
| One-time setup fee | From PKR 50,000 for larger setups | None |
| Where the data lives | Vendor's cloud, browser based | The shop's own computer, offline-first |

The pitch is simple: the same capabilities, no monthly bill, no per-seat fees, and the shop owns its data. Tillbase does not need to out-feature every paid product on day one. It needs to be good enough that a shop has no reason to pay.

Source for the competitor facts: [pricing](https://www.granetpro.com/pricing.html), [POS features](https://www.granetpro.com/pos-software-in-pakistan.html), [restaurant features](https://www.granetpro.com/restaurant-pos-software-pakistan.html). Vendors change their pages, so recheck before quoting.

## What is built

- [x] Core engine: products, barcode lookup, stock movements, transactional checkout, split payments, voids, reports, receipts
- [x] Desktop app: checkout, products, stock adjustment, sales, void, settings
- [x] Staff PIN login, roles (owner, manager, cashier) and permissions
- [x] Shifts: open with a float, cash in and out, close with a counted drawer and variance
- [x] Fast-food orders: token numbers, order types, held orders, add-ons, kitchen tickets and board
- [x] Delivery charge on delivery orders (counted as income, never as a menu item), several payments on one sale in the pay screen, and splitting a dine-in bill by items into separate bills
- [x] CSV import and export of menu items, with a preview of every change before anything is saved (ingredients and recipes are not included)
- [x] Business suite, slice 1: ingredients and recipes with real cost of goods, purchases with weighted-average cost and supplier payables, wastage valued at cost, running costs, attendance and payroll (monthly, daily, hourly, overtime, advances), profit and loss with break-even and per-item margins, business payments from the till drawer, daily automatic backups

## Audit notes (November 2026)

A full review of the code found no security or correctness blockers: 0 known vulnerabilities in production dependencies, every one of the 78 API methods matched to a handler, every handler except the public settings read checks permissions, and Electron runs with context isolation, sandbox and a content security policy. The gaps that matter most for a real shop are, in order: the first-run currency and country (new installs start in US dollars), a business-day cutoff for late-night trading, an Urdu interface, off-site backups, and database indexes for voids and the wastage report as data grows. Installers and cross-platform CI are done. These are in "Planned phases" below.

## Planned phases

**Phase 2: run a real shop day** (in progress)
Staff and shifts (done), menu CSV import and export (done). Next: first-run currency and country, business-day cutoff so after-midnight sales belong to the right day, customers with loyalty points and a wallet, dual tax rates for cash and card.

**Phase 3: restaurants** (fast-food billing done: daily tokens, dine-in/takeaway/delivery, delivery fees, held orders, add-ons with cost, send-to-kitchen tickets, kitchen board, split bills)
Delivery fees and splitting a bill by items are done. Still to do: floor plan, rider tracking, combos, kitchen stations, a customer-facing token screen.

**Phase 4: back office** (recipes, costs, purchases, payroll and profit and loss are done)
Still to do: purchase orders, expiry tracking, supplier ledger statements, recurring expenses, accountant export.

**Phase 5: more than one till and more than one shop**
Several terminals on one local network, then multi-branch with sync when online, plus an owner dashboard.

**Phase 6: hardware and shipping**
Direct ESC/POS thermal printing and cash drawer kick, silent printing, translations including Urdu.

## Compliance note (important)

Pakistani tax authorities (FBR, and the provincial PRA and SRB) require point-of-sale software to be registered and integrated through their own programmes. We can build the invoice formats, QR codes and reporting hooks, but a shop should not treat Tillbase as compliant until the integration has been officially approved. We will say so plainly in the app and the README until that happens, rather than imply approval we do not have.

## How we decide what to build

1. Does a shop lose money or time without it?
2. Is it something the paid products put behind a paywall?
3. Can we test it end to end?

Features that fail the third question do not ship.
