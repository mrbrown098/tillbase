# Publishing to winget, Scoop and Homebrew (later)

**Status: nothing here is done, and none of it has been tried.** This is a plan for when Tillbase has a few real releases, written down so the next person does not start from zero. Facts about the three package managers were checked against their own documentation on 2026-11-21 (links at the end); their rules change, so read the current docs before you start. Anything marked *untested* is a guess to be verified.

## What we can offer them

Every release (see [RELEASING.md](RELEASING.md)) has these files on its GitHub Release page, with the checksums in `SHA256SUMS.txt` (one `hash  filename` line per file):

| System | File | Notes |
|---|---|---|
| Windows 64-bit | `Tillbase-X.Y.Z-win-x64-setup.exe` | NSIS installer, installs **per user** (no administrator rights), silent install with `/S`. |
| macOS Apple Silicon | `Tillbase-X.Y.Z-mac-arm64.dmg` | Contains `Tillbase.app`. |
| macOS Intel | `Tillbase-X.Y.Z-mac-x64.dmg` | Contains `Tillbase.app`. |

The app id is `com.tillbase.app`. The shop's data is **never** inside the install folder, and uninstalling never deletes it (`deleteAppDataOnUninstall: false`). Keep it that way in every package: do not add a "zap" or clean-up step that removes the data folder.

**The builds are not code-signed** (see "Unsigned builds" in RELEASING.md). That matters differently for each manager below.

## Do this first, once per release: the checklist

1. The release is **published** (not a draft) and the three files and `SHA256SUMS.txt` are on it.
2. Download each file from the public release page and check its hash against `SHA256SUMS.txt`.
3. Update the manifests below with the new version, URLs and hashes, test, and submit.

A small script in `scripts/` that prints the three hashes in the shape each manager wants would remove most of the manual work. It does not exist yet.

## winget (Windows)

winget searches the public [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) repository. You add a manifest through a pull request; automated checks (install, uninstall, antivirus scan) run, then a person reviews it.

Requirements from Microsoft's documentation that matter for us:

- The installer URL must be **https**, point directly at the publisher's release location (a GitHub Release asset qualifies; redirectors are not allowed), and must not return 403 or 404.
- The SHA-256 must match the file.
- The installer must install **silently** and uninstall completely, as an administrator and as a normal user, and must pass antivirus scanning without warnings.
- Files go in `manifests/t/Tillbase/Tillbase/X.Y.Z/` (first letter of the publisher, publisher, application, version), and the identifier and version in the files must match that path. One package version per pull request.

Sketch of the installer manifest (*untested*; check the current manifest schema version and field names with `winget validate`):

```yaml
PackageIdentifier: Tillbase.Tillbase
PackageVersion: X.Y.Z
InstallerType: nullsoft
Scope: user
Installers:
  - Architecture: x64
    InstallerUrl: https://github.com/mrbrown098/tillbase/releases/download/vX.Y.Z/Tillbase-X.Y.Z-win-x64-setup.exe
    InstallerSha256: <from SHA256SUMS.txt, upper-case>
ManifestType: installer
ManifestVersion: 1.6.0
```

The documentation does not say that code signing is required. Whether an unsigned installer passes the automated antivirus and reviewer checks is **unknown**: try it with a pre-release in a fork and read what the checks say. Test locally first with `winget validate` and the repository's `Tools/SandboxTest.ps1` (Windows Sandbox). The `wingetcreate` tool can generate and update these files and open the pull request; try it, it is not covered by the page above.

## Scoop (Windows)

Scoop installs from "buckets", which are Git repositories of JSON manifests. The simplest start is **our own bucket**, a repository such as `mrbrown098/scoop-tillbase`, so no one else has to approve anything: people run `scoop bucket add tillbase https://github.com/mrbrown098/scoop-tillbase` then `scoop install tillbase`. Getting into the official `extras` bucket is a later step with its own criteria (read them first).

Scoop updates itself from a manifest using `checkver` and `autoupdate`. For a GitHub Release, per Scoop's documentation:

```json
{
  "version": "X.Y.Z",
  "description": "Free, open source, offline-first point of sale for shops and restaurants.",
  "homepage": "https://github.com/mrbrown098/tillbase",
  "license": "MIT",
  "checkver": "github",
  "autoupdate": {
    "url": "https://github.com/mrbrown098/tillbase/releases/download/v$version/<file>",
    "hash": { "url": "$baseurl/SHA256SUMS.txt" }
  }
}
```

`checkver: "github"` ignores pre-releases, which is what we want. `SHA256SUMS.txt` is already in the `hash  filename` shape Scoop's default pattern reads.

**Open question (untested):** Scoop is built around archives and portable apps. Our Windows file is an NSIS installer. Either (a) add a portable **zip** to the release (an extra `win` target in `electron-builder.yml`, and a line in the release workflow's file list and checks), which suits Scoop best, or (b) have the manifest run the installer silently through an `installer` script. Try both in your own bucket before choosing. A zip also needs a note that the data folder is the normal per-user one, so removing it with Scoop does not remove the shop's data.

## Homebrew (macOS)

Homebrew installs Mac apps with a **cask**.

**Official cask (homebrew/cask): not possible yet.** Homebrew 5.0.0 (12 November 2025) deprecated casks that are not code-signed, and its announcement says all casks in `Homebrew/homebrew-cask` that fail Gatekeeper checks will be disabled in **September 2026**. Our macOS builds are only ad-hoc signed and not notarized, so they fail Gatekeeper on a downloaded copy. Submitting to the official repository needs a **Developer ID certificate and Apple notarization** first (the steps are in RELEASING.md, "Adding code signing later"). Check the current state of that policy before you try.

**Our own tap: possible now (untested).** A tap is a repository named `homebrew-<something>`, for example `mrbrown098/homebrew-tillbase`, with `Casks/tillbase.rb`. People run `brew install --cask mrbrown098/tillbase/tillbase`. The announcement describes the Gatekeeper timeline for the official repository only and says nothing about third-party taps, so what will happen to an unsigned cask in a tap is **unknown**; also expect macOS to show the same "developer cannot be verified" warning that RELEASING.md describes.

Sketch of the cask (*untested*):

```ruby
cask "tillbase" do
  version "X.Y.Z"

  on_arm do
    sha256 "<hash of the arm64 dmg, from SHA256SUMS.txt>"
    url "https://github.com/mrbrown098/tillbase/releases/download/v#{version}/Tillbase-#{version}-mac-arm64.dmg"
  end
  on_intel do
    sha256 "<hash of the x64 dmg, from SHA256SUMS.txt>"
    url "https://github.com/mrbrown098/tillbase/releases/download/v#{version}/Tillbase-#{version}-mac-x64.dmg"
  end

  name "Tillbase"
  desc "Free, open source, offline-first point of sale for shops and restaurants"
  homepage "https://github.com/mrbrown098/tillbase"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Tillbase.app"
  # Deliberately no `zap`: it would delete ~/Library/Application Support/Tillbase, which is the shop's data.
end
```

Test it with `brew audit --cask --online`, `brew style` and a real `brew install --cask` on an Apple Silicon and an Intel Mac before announcing it.

## Suggested order

1. Get a few releases out and stable, and write the README "install" lines for the installers first.
2. Scoop in our own bucket, and winget (cheap to try, and Windows is the most common system for shops).
3. A Homebrew tap, now or later, accepting the unsigned warning, **or** wait for signing and go straight to the official cask.
4. When a code-signing certificate exists, redo the checks above: signing changes the answer for winget (fewer warnings), Scoop (none), and Homebrew (the official cask becomes possible).

## Sources

- Microsoft, [Submit your manifest to the repository](https://learn.microsoft.com/windows/package-manager/package/repository) (winget).
- Scoop wiki, [App Manifest Autoupdate](https://github.com/ScoopInstaller/Scoop/wiki/App-Manifest-Autoupdate).
- Homebrew, [Homebrew 5.0.0 release notes](https://brew.sh/2025/11/12/homebrew-5.0.0) (code-signing deprecation and the September 2026 date).
