# Sponsors

Tillbase is free and open source (MIT) and it stays that way: **no paid tiers, no locked features**. A small, quiet sponsor line at the bottom of the window may pay for the things that keep the project going. This folder holds the list of sponsor messages and the rules for them.

- [`manifest.json`](manifest.json) is the list. It is a plain file in this repository, so every change to it is a public pull request. **Today it has zero sponsors**, and the app shows nothing.
- [`manifest.schema.json`](manifest.schema.json) describes its exact shape. The app reads the manifest in this shape and nothing else.
- [`banned-words.json`](banned-words.json) is the list of words that are never allowed in an ad.
- [`scripts/validate-ads.mjs`](../scripts/validate-ads.mjs) checks all of it, and runs on every pull request that touches this folder. A pull request that fails it cannot be merged.

## What a sponsor message looks like

One short line of plain text, an optional small still picture, and a link:

```json
{
  "version": 1,
  "updated": "2026-12-01",
  "slots": {
    "footer": [
      {
        "id": "acme-pos-2026-q4",
        "sponsor": "Acme POS Hardware",
        "text": "Receipt printers and barcode scanners for small shops.",
        "image": "https://acme-pos.example.com/tillbase-banner.png",
        "url": "https://acme-pos.example.com/tillbase",
        "category": "pos-hardware",
        "start": "2026-12-01",
        "end": "2027-02-28",
        "weight": 5
      }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `id` | Unique, lower-case letters, digits and dashes. |
| `sponsor` | Who is paying, up to 60 characters. |
| `text` | Plain text, **at most 90 characters**, no link and no markup in it. |
| `image` | Optional. `https`, a **PNG or WebP**, **at most 600 x 100 pixels and 100 KB**, a still picture, and no `?` part in the address. |
| `url` | `https` only, a real website. |
| `category` | One of: `pos-hardware`, `payments`, `packaging`, `accounting`, `food-supply`, `business-software`, `education`. |
| `start`, `end` | Real dates, `YYYY-MM-DD`, inclusive. `end` is not before `start`. |
| `weight` | Whole number 1 to 10: how often it is picked compared with the others. |

Nothing else is allowed in an entry. An unknown field is rejected, so nothing can carry a hidden tracker.

## The policy

Sponsors must be businesses that help a shop or restaurant run (the categories above). These are **never** accepted, whatever the pay:

- adult content, gambling and betting, alcohol, tobacco, vaping, loans and credit offers, crypto, "get rich" schemes;
- fake virus or security warnings, "you have won" messages, and anything that pretends to be part of Tillbase or of the user's computer;
- pop-ups, pop-unders, anything that opens by itself, or anything that covers the till;
- **motion**: no animated pictures, no scrolling or blinking text;
- **autoplay**: no sound or video;
- **tracking**: no tracking pixels, no pictures loaded from a tracking address (a `?` part in an image link is refused), no scripts, and no extra fields. A click opens the sponsor's website in the browser and that is all.

Also:

- **Every sponsor is a reviewed pull request.** A maintainer checks that the business is real, that it fits the policy, and that the text is honest. The validator is a floor, not the whole review.
- **Ads are never in the way of selling.** They appear in the footer only, as one line, and never on the payment or receipt screens.
- **Sponsors get no say in the software.** No feature, default, report or setting is changed for a sponsor, and sponsors never see anything about any shop. Tillbase holds no data about shops.
- A message can be removed at any time if it breaks the rules or turns out to be misleading.
- Anyone can report an ad by opening an issue.

## How a business can sponsor

1. Open an issue titled **Sponsor: your business name**, with your website, which category you fit, and the dates you would like.
2. A maintainer replies in the issue. The terms are agreed there, in public.
3. You (or the maintainer) open a pull request that adds one entry to `manifest.json`. CI runs the validator. If it fails, the messages say exactly what to change.
4. A maintainer reviews and merges. The message is shown from its `start` date and disappears after its `end` date, with no further change needed.

## How the money is used

Sponsorship money pays for what the project needs to keep being free: code-signing certificates (so the installers stop showing "unknown publisher" warnings), build and hosting costs, and maintainers' time. The amounts and how they were spent are reported openly in this repository.

## Checking your change before you open a pull request

```bash
node scripts/validate-ads.mjs              # checks the file and downloads each image to measure it
node scripts/validate-ads.mjs --offline    # same, without downloading images
node --test scripts/validate-ads.test.mjs  # the validator's own tests
```
