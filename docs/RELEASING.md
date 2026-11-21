# Releasing Tillbase

A release is a set of installers attached to a GitHub Release, so a shop owner can download one file and run Tillbase without Node.js, npm or any other developer tool.

## What a release contains

For version `X.Y.Z` the release workflow produces exactly these files:

| Operating system | File | Notes |
|---|---|---|
| Windows 10/11, 64-bit | `Tillbase-X.Y.Z-win-x64-setup.exe` | Installer wizard. Installs for the current user, no administrator rights needed. |
| macOS, Apple Silicon (M1 and newer) | `Tillbase-X.Y.Z-mac-arm64.dmg` | Open it and drag Tillbase to Applications. |
| macOS, Intel | `Tillbase-X.Y.Z-mac-x64.dmg` | Same. |
| Linux, 64-bit | `Tillbase-X.Y.Z-linux-x86_64.AppImage` | Runs anywhere: `chmod +x` it and double-click. |
| Debian, Ubuntu and similar | `Tillbase-X.Y.Z-linux-amd64.deb` | `sudo apt install ./Tillbase-X.Y.Z-linux-amd64.deb` |
| all | `SHA256SUMS.txt` | Checksums, so a download can be verified. |

Where the shop's data lives (it is never inside the install folder, so updating or uninstalling does not delete it):

| System | Folder | Database file |
|---|---|---|
| Windows | `%APPDATA%\Tillbase` | `tillbase.sqlite` |
| macOS | `~/Library/Application Support/Tillbase` | `tillbase.sqlite` |
| Linux | `~/.config/Tillbase` | `tillbase.sqlite` |

Daily backups are kept in a `backups` folder next to the database. There is no automatic updater: to update, install the newer version over the old one. The data is kept.

## Cutting a release

You need push access to the repository. Do this from an up-to-date `main` with all checks green.

1. **Check `main` is healthy.** The latest CI run on `main` must be green on all three operating systems.

2. **Bump the version** in all three `package.json` files and the lockfile. The release workflow refuses a tag that does not match them.

   ```bash
   git checkout main && git pull
   npm version X.Y.Z --no-git-tag-version --workspaces --include-workspace-root
   git add -A
   git commit -m "Release vX.Y.Z"
   ```

   Open a pull request for this commit and merge it (or push it to `main` if you are allowed to).

3. **Tag the merged commit and push the tag.**

   ```bash
   git checkout main && git pull
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   For a test build use a tag with a dash, such as `v0.2.0-beta.1`. It is marked as a pre-release. (Its `package.json` version must be `0.2.0-beta.1` too.)

4. **Wait for the Release workflow** (Actions tab, "Release"). It takes roughly 15 to 30 minutes. It:
   1. checks that the tag matches the version in `package.json`, `packages/core/package.json` and `packages/desktop/package.json`;
   2. on Windows, macOS (Apple Silicon and Intel) and Linux runners, builds the app and its installer with electron-builder;
   3. checks that the SQLite native module inside each installer was built for that operating system and CPU;
   4. **installs each installer on that operating system and launches the installed app** with the same smoke test used in CI: the "Welcome to Tillbase" screen appears, the owner can be created, the Checkout tab shows, and no errors are logged. If any of this fails, nothing is uploaded for that system and no release is created;
   5. creates a **draft** GitHub Release with all installers and `SHA256SUMS.txt`, and generated release notes.

5. **Review and publish the draft.** On the Releases page, open the draft, check the file names above, edit the notes, and click **Publish release**. A draft is invisible to the public, so nothing is released by accident.

If the workflow fails, fix the problem on `main`, delete the tag (`git push --delete origin vX.Y.Z` and `git tag -d vX.Y.Z`), and tag again. Delete the draft release too if one was created.

### Building installers locally

```bash
npm ci
npm run build -w @tillbase/core
npm run dist -w @tillbase/desktop -- --linux     # or --win, --mac (each only on its own OS)
```

Installers appear in `packages/desktop/release/`. Windows and macOS installers should be built on Windows and macOS: SQLite is a native module, so each platform builds its own copy.

## Unsigned builds: what users will see

**The installers are not code-signed yet.** Signing needs paid certificates that the project does not have. The installers are safe to run if downloaded from this repository's Releases page, but the operating systems cannot verify who made them, so they show warnings. Tell shop owners about these before they download.

### Windows: SmartScreen warning

Running `Tillbase-...-setup.exe` shows a blue "Windows protected your PC" screen. Click **More info**, then **Run anyway**. The warning is expected for any unsigned program and may keep appearing for a while even after the app is widely downloaded, because SmartScreen builds reputation per signing certificate.

### macOS: "cannot be opened because the developer cannot be verified"

The app is ad-hoc signed (so that it runs on Apple Silicon) but not signed by an identified developer and not notarized by Apple, so Gatekeeper blocks the first launch of a downloaded copy.

- **macOS 14 and earlier:** in Finder, **right-click** (or Control-click) Tillbase in Applications, choose **Open**, then click **Open** in the dialog. This is needed only once.
- **macOS 15 (Sequoia) and later:** the right-click shortcut no longer works. Try to open the app once, then go to **System Settings, Privacy & Security**, scroll down, and click **Open Anyway** next to the Tillbase message.
- **Alternative for any version:** run `xattr -dr com.apple.quarantine /Applications/Tillbase.app` in Terminal, then open the app normally.

### Linux

No warning. For the AppImage, mark it executable first (right-click, Properties, "Allow executing as program", or `chmod +x`).

## Adding code signing later

None of this is set up or tested. It is the list of what to do once the project has the money or a sponsor.

**Windows**

1. Get a code-signing certificate from a certificate authority, or use a cloud signing service (for example Azure Trusted Signing or SignPath, which avoid holding a private key). Certificates from a normal authority build SmartScreen reputation over time; an Extended Validation certificate removes the warning almost immediately.
2. Store the certificate and its password as repository secrets, and pass them to the build step in `.github/workflows/installers.yml` as `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` (electron-builder reads these). Cloud signing services have their own electron-builder settings under `win.signtoolOptions` or `win.azureSignOptions`; follow the electron-builder documentation for the service you pick.

**macOS**

1. Join the Apple Developer Program (a yearly fee) and create a **Developer ID Application** certificate. Export it as a `.p12` file.
2. Add repository secrets for the certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and for notarization (an App Store Connect API key: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
3. In `packages/desktop/electron-builder.yml`: remove `identity: null`, remove the `afterPack` line (and delete `scripts/adhoc-sign.cjs`), set `hardenedRuntime: true`, and set `notarize: true`. With hardened runtime on, Electron needs entitlements (at least `com.apple.security.cs.allow-jit` and `allow-unsigned-executable-memory`) in a `build/entitlements.mac.plist` file referenced by `mac.entitlements` and `mac.entitlementsInherit`.
4. In `.github/workflows/installers.yml`, remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` so electron-builder uses the certificate.

After adding signing, update this document and the README so they no longer say the builds are unsigned.

## What is and is not tested

Every pull request and every release runs the installer jobs in `.github/workflows/installers.yml` on real Windows, macOS (Apple Silicon and Intel) and Linux machines. A job only passes when the **installed** app launches and completes the smoke test (`scripts/smoke.mjs`).

Not covered by any automated check:

- Gatekeeper and SmartScreen behaviour on a real downloaded file (the CI machines install files that were never downloaded, so they are not quarantined).
- Windows on ARM, Linux on ARM, and 32-bit systems. No installers are built for them.
- Uninstalling, and upgrading over an older version.
- Other Linux distributions than the Ubuntu runner. The AppImage is expected to work on most distributions, but only Ubuntu is tested.
- Printing, barcode scanners and any other hardware.
