# Troubleshooting

## The app does not start after `npm run app`

Copy the **first error line** from the terminal and open an issue with it. Common causes:

**1. Wrong Node version.** Tillbase needs Node.js 20 or newer. Check with `node --version`.

**2. The SQLite module could not be prepared for Electron.**
`npm run app` first downloads a ready-made SQLite binary for your Electron version. If your network blocks
the download, it falls back to compiling from source, which needs:
- Windows: install "Visual Studio Build Tools" with the **Desktop development with C++** workload, and Python 3.
- macOS: `xcode-select --install`
- Linux: `sudo apt install build-essential python3` (or your distribution's equivalent)

Then run `npm run rebuild -w @tillbase/desktop` and try again.

**3. Linux, running as root:** Electron refuses to start as root. Run as a normal user.

**4. "NODE_MODULE_VERSION ... was compiled against a different Node.js version"**
Electron and plain Node need different builds of SQLite.
- Before running the **app**: `npm run rebuild -w @tillbase/desktop`
- Before running the **tests**: `npm run rebuild:node`

## Where is my data?

In one SQLite file in the app's data folder. The exact path is printed in the terminal when the app starts
("Tillbase data file: ..."). Daily backups are kept in a `backups` folder next to it. To move to a new computer, copy the database file.
