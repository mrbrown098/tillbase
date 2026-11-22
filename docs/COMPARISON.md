# How Tillbase compares

An honest comparison, so you can choose what fits your shop. Facts about other products come from their public GitHub pages as read on 21 November 2026 and may change; if one is wrong, please open an issue and we will fix it. "Not listed" means the project's own description does not mention it, not that it is impossible.

We could not find reliable public information about **LogicPOS**, so it is left out rather than guessed.

| | **Tillbase** | **NexoPOS** | **Posnic POS** |
|---|---|---|---|
| Price of the core | Free forever, MIT | Free core, GPL-3.0 | Free, AGPL-3.0 |
| Paid parts | None. Nothing is locked | Extra modules such as Gastro (restaurants) and MultiStore are sold separately through its marketplace; prices not stated on the project page | "Posnic Cloud", a paid service for multi-till sync and off-site backups |
| How it runs | Desktop app, one SQLite file, no server to set up | Web app you host: PHP 8.2+, MariaDB or MySQL, a web server and a queue worker | Desktop app with a local MongoDB database |
| Works offline | Yes, fully | Depends on your own server | Yes |
| Install effort | Run the installer | Set up and maintain a server | Install the app and a MongoDB database |
| Selling, split payments, holds | Yes | Yes | Yes |
| Restaurant orders and kitchen board | Yes | Via the paid Gastro module | Kitchen tickets and tables |
| Recipes and real food cost per dish | Yes | Not listed | Not listed |
| Staff attendance and payroll | Yes | Not listed | Staff activity reports |
| Profit and loss with "where the money went" | Yes (owner only) | Accounting and reports | Profit reports |
| Customers and loyalty | Yes: phone search, points, a wallet and khata (sell on account, credit limits, repayments, printable statements) | Customer groups, rewards, coupons | Accounts and balances |
| Thermal printers, cash drawer, scales | Receipts for 58/80 mm paper now; direct thermal printing and drawer planned | Barcode and scale support | Documented hardware paths |
| Tax invoices (GST and similar) | Not yet. Not approved for FBR, PRA or SRB | Not listed | GST invoices |
| Multiple branches | Planned | Paid MultiStore module | Yes (cloud sync is paid) |
| Urdu | Planned | Not listed | Not listed |

## Where Tillbase is stronger

- No subscription and no feature behind a paywall, ever.
- Nothing to host: install and sell. That matters for a shop without an IT person.
- It answers the owner's money question (dish cost, wages, running costs, profit) in one screen.
- Plain English everywhere, built for a small shop first.

## Where Tillbase is behind, and what we are doing about it

- No multi-branch or multi-terminal sync yet.
- No tax-authority invoices yet.
- No direct thermal printing yet.
- Younger: fewer shops have used it. Please try it and tell us what breaks.

All of these are on the [roadmap](ROADMAP.md).
