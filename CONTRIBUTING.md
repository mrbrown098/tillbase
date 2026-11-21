# Contributing to Tillbase

Thank you for helping. Tillbase is free and open source (MIT), built for real shops and restaurants, and it stays free: no paid tiers, no locked features. Code, translations, testing in a real shop, clear bug reports and documentation fixes all count.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security problem? Do **not** open a public issue; follow [SECURITY.md](SECURITY.md).

## Before you start

1. Read **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**. It is short and holds the rules the code must follow: money is an integer in minor units, migrations are append-only, stock is a log, permissions are enforced in the main process.
2. For anything bigger than a small fix, **open an issue first** (or comment on an existing one) saying what you want to build, so two people do not build the same thing and so you do not spend a weekend on something that will not be merged. The [roadmap](docs/ROADMAP.md) lists what is wanted.
3. Small fixes (typos, a clear bug with a clear fix) can go straight to a pull request.

## Getting the code running

You need **Node.js 22 or newer** and npm.

```bash
git clone https://github.com/mrbrown098/tillbase.git
cd tillbase
npm ci
npm run app          # builds everything and opens the app
```

If the app does not start, see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). To run the tests afterwards:

```bash
npm run rebuild:node   # SQLite needs a different build for plain Node than for Electron
npm test
npm run typecheck
```

`npm run app` prepares SQLite for Electron, so run `npm run rebuild:node` again before the tests.

## Making a change

1. Branch from the latest `main`: `git checkout -b feature/short-name` (use `fix/...` for a bug fix, `docs/...` for documentation). Never push to `main`.
2. Keep the change focused: one feature or fix per pull request.
3. **Write tests.** Every business rule gets a test. For anything with money, work the expected numbers out by hand in a comment and assert them; do not copy what the code printed.
4. **Run the real app** for anything with a screen and look at it. Tests passing is not the same as it working.
5. Run `npm run rebuild:node && npm test && npm run typecheck`. They must pass.
6. Rebase on the newest `main`, then open the pull request.

### Rules that save you a rejected pull request

- **Windows, macOS and Linux all run in CI.** Never split paths on `/` or `\`; use `path.basename`, `path.join` and friends.
- **A new API method needs three edits**: `TillbaseApi` and `channels` in `packages/desktop/shared/api.ts`, and the implementation in `electron/handlers.ts` (with its permission check).
- **A database change is a new migration** at the end of `packages/core/src/migrations.ts`, never an edit to an old one, with a test that upgrades a database from the previous version with real data in it.
- **Shared files** (`migrations.ts`, `core/src/index.ts`, `shared/api.ts`, `handlers.ts`, `App.tsx`, `styles.css`, `CHANGELOG.md`) are touched by almost every change. Keep edits there small and additive, and put new logic in a new file.
- **Do not add a dependency fetched over git.** `package-lock.json` must only point at the npm registry; CI checks this.
- **Be honest on screen.** If a number may be wrong (a missing cost, estimated wages), say so. Never claim approval by a tax authority.
- **Use plain, kind words.** The people using Tillbase run shops, not accounting departments.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for anything a shop owner would notice.

## The pull request

The pull request template asks what you changed, what you ran, and what you did **not** test. Please fill it in truthfully; "I could not test this on Windows" is a perfectly good answer and helps the reviewer. CI must be green: tests and type checks on Linux, Windows and macOS, a real launch of the app, a fresh-clone install with the newest npm, and the installer builds.

Commit messages: a short summary line in the imperative ("Add supplier statement"), then a paragraph on *why* if it is not obvious.

## Reporting a bug or asking for a feature

Use the issue forms: **Bug report** (it asks for your operating system, Node version if you run from source, and app version) or **Feature request**. The more exactly you describe what you did and what you saw, the faster it gets fixed.

## Licence

Tillbase is [MIT licensed](LICENSE). By contributing you agree that your contribution is released under the same licence.
