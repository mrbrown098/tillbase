# Security

Tillbase handles shop sales, staff PINs and wages, so we take reports seriously.

## Report a problem

Please **do not** open a public issue for a security problem. Use GitHub's private reporting: the **Security** tab of this repository, then **Report a vulnerability**. Say what you found, how to reproduce it, and which version. We aim to answer within 7 days.

## What we do

- Permissions are checked in the app's main process, not only hidden in the screens.
- PINs are stored as salted hashes. Wrong PINs lock the account for 30 seconds. The till signs out after 5 idle minutes.
- The app window runs with context isolation, a sandbox and a strict content security policy. It cannot load remote scripts.
- Everything stays on the shop's own computer. Tillbase sends no data anywhere.
- Dependencies are kept current and checked with `npm audit`.

## Supported versions

Only the newest release receives fixes while the project is young.
