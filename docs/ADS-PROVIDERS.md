# Ad providers: what is allowed, and why

Tillbase is free and stays free. Sponsor banners are one way to pay for signing certificates and hosting. This
page records how banners work today and what must be true before any outside ad network is switched on.

## How it works today (direct sponsors)

- The banner list is one public file in this repository: `ads/manifest.json` (rules in `ads/README.md`).
- The app downloads that file (a plain GET, cached 6 hours) and shows **one** line on the **Home** screen only.
  It is labelled "Sponsored". It is never shown at checkout, payment, login, orders, kitchen or receipts.
- No scripts run. Only text and an optional still PNG/WebP (at most 600x100 px, 100 KB) are used. The image is
  checked from its real bytes, not its file name.
- Nothing about the shop, its sales or its staff is sent. There is no tracking and no cookies.
- If the file cannot be fetched, is invalid, or has no live sponsor, the app shows nothing. It never slows a sale.
- **Kill switches:** the owner can turn sponsors off in Settings. `TILLBASE_NO_ADS=1` turns them off for
  the whole machine. Removing the sponsors from `ads/manifest.json` turns them off for everyone.
- Every sponsor entry is reviewed by hand and checked by `npm run validate-ads` in CI (https only, allowed
  categories, banned words, dates, size limits).

## Outside ad networks: not enabled

An outside network is only acceptable if **all** of these are verified in writing:

1. It serves **desktop applications** (many networks only serve websites or mobile apps).
2. It can serve **static banners only**, with no pop-ups, redirects, push notifications or auto-playing media.
3. It supports **category blocking** (no adult, gambling, alcohol, weapons, scams or misleading "download"
   buttons) and a way to report and remove an ad.
4. It does not need a third-party script running inside the app. Tillbase will not run remote code next to
   the shop's till, so the only possible design is a server-side feed that this repository reviews.
5. It can **pay out in Pakistan** (bank transfer), and its minimum payout and terms are known.
6. Its privacy terms do not require collecting shop or customer data.

### Microsoft Advertising / Microsoft Ads Network (looked at, not enabled)

This is only what could be found publicly; nothing has been signed up for.

| Question | Finding |
|---|---|
| Serves desktop Electron apps? | Not stated. The product is built around web, search and in-app placements. |
| Static banners only? | Not guaranteed. The network also sells pop-under and push formats. |
| Category blocking? | Not confirmed for a publisher of this size. |
| Pakistan payout? | Not confirmed. A minimum payout and net-30 terms were mentioned. |

**Result:** stays disabled. Questions to send to the network before any decision:

1. Do you approve a free, open-source desktop point-of-sale application as a placement?
2. Can we restrict ourselves to one static banner size, with no pop-ups, push or video?
3. Can we block categories (adult, gambling, alcohol, weapons, dating, finance offers)?
4. Can creatives be reviewed before they run, or reported and removed within a day?
5. Can you pay a Pakistani bank account, and what are the minimum payout and the payment terms?
6. Can the feed be fetched server-side, so no third-party script runs in the app?

Any network that passes would be added behind the same provider boundary (`electron/ads.ts` returns an
`AdView`: id, sponsor, text, optional image) so the screen does not change, and it would ship off by
default until the owner approves it.

## Money and approvals

No ad contract, payout account or spending is set up without the project owner's approval.
