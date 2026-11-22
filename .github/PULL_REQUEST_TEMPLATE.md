## What does this change, and why?

<!-- A few sentences. Link the issue: "Closes #123". -->

## What I ran

<!-- Only things you actually ran. Paste the result, for example the test counts. -->

- [ ] `npm run rebuild:node && npm test`
- [ ] `npm run typecheck`
- [ ] Ran the real app (`npm run app`) and used the screen I changed
- [ ] Tests added or updated (money: expected numbers worked out by hand)

## What I did **not** test

<!-- Be honest: another operating system, a printer, a real shop, upgrading an old database... "Nothing" is fine if true. -->

## Checklist

- [ ] One change per pull request, branched from the latest `main` and rebased
- [ ] Paths use `path.join` / `path.basename`, never split on `/` or `\`
- [ ] Database change? It is a **new** migration with an upgrade test
- [ ] New API method? `TillbaseApi`, `channels` and `handlers.ts` (with its permission check) all updated
- [ ] Screens are honest about numbers that may be wrong, and use plain words
- [ ] No dependency fetched over git; `package-lock.json` only points at the npm registry
- [ ] `CHANGELOG.md` has a line under `[Unreleased]` if a shop owner would notice the change
- [ ] I followed the [Code of Conduct](https://github.com/mrbrown098/tillbase/blob/main/CODE_OF_CONDUCT.md) and [CONTRIBUTING.md](https://github.com/mrbrown098/tillbase/blob/main/CONTRIBUTING.md)
