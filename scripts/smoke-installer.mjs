// Installs a built Tillbase installer the way a user would, then runs scripts/smoke.mjs against the
// INSTALLED app (not the build folder). It uses the app's normal per-user data folder, so run it only
// on a throwaway machine such as a CI runner.
//
//   node scripts/smoke-installer.mjs windows              Windows NSIS installer, silent install
//   node scripts/smoke-installer.mjs mac                  macOS dmg for this machine's CPU
//   node scripts/smoke-installer.mjs appimage             Linux AppImage
//   node scripts/smoke-installer.mjs deb                  Linux .deb installed with apt-get
//
// Options: --release <dir> (default packages/desktop/release), --shots <dir> (default smoke-output)
//
// The installer must have been built for the same operating system and CPU as the machine running this.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const args = process.argv.slice(2);
const kind = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const release = resolve(opt("--release", join(root, "packages", "desktop", "release")));
const shots = resolve(opt("--shots", "smoke-output"));

const log = (msg) => console.log(`[installer-smoke] ${msg}`);
const die = (msg) => {
  console.error(`[installer-smoke] FAIL: ${msg}`);
  process.exit(1);
};

function run(cmd, cmdArgs, options = {}) {
  log(`$ ${cmd} ${cmdArgs.join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...options });
  if (r.status !== 0) die(`${cmd} exited with ${r.status ?? r.signal}`);
}

function find(pattern) {
  if (!existsSync(release)) die(`release folder not found: ${release}`);
  const hit = readdirSync(release).find((f) => pattern.test(f));
  if (!hit) die(`no installer matching ${pattern} in ${release} (found: ${readdirSync(release).join(", ")})`);
  return join(release, hit);
}

function smoke(exe) {
  log(`running the app smoke test against the installed app: ${exe}`);
  const r = spawnSync(
    process.execPath,
    [join(root, "scripts", "smoke.mjs"), "--exe", exe, "--default-data", "--expect-packaged", "--shots", shots],
    { stdio: "inherit" },
  );
  if (r.status !== 0) die("the installed app failed its smoke test");
}

function runAsRoot(cmd, cmdArgs) {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  if (isRoot) run(cmd, cmdArgs);
  else run("sudo", [cmd, ...cmdArgs]);
}

/** The smoke test needs a first run, so remove any data folder left by an earlier run on this machine. */
function startFresh() {
  const dataDir =
    process.platform === "linux"
      ? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Tillbase")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "Tillbase")
        : join(process.env.APPDATA ?? "", "Tillbase");
  if (dataDir !== "Tillbase" && existsSync(dataDir)) {
    log(`removing the data folder from an earlier run: ${dataDir}`);
    rmSync(dataDir, { recursive: true, force: true });
  }
}

mkdirSync(shots, { recursive: true });
startFresh();

switch (kind) {
  case "windows": {
    if (process.platform !== "win32") die("the windows check must run on Windows");
    const installer = find(/-win-x64-setup\.exe$/);
    const dir = join(process.env.SystemDrive ?? "C:", "tillbase-smoke-install"); // no spaces: /D= must be unquoted
    // /S = silent. /D= sets the install folder and must be the last argument.
    run(installer, ["/S", `/D=${dir}`]);
    const exe = join(dir, "Tillbase.exe");
    for (let i = 0; i < 60 && !existsSync(exe); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    if (!existsSync(exe)) die(`installer finished but ${exe} does not exist`);
    if (!existsSync(join(dir, "Uninstall Tillbase.exe"))) die("installer did not create an uninstaller");
    smoke(exe);
    break;
  }
  case "mac": {
    if (process.platform !== "darwin") die("the mac check must run on macOS");
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const dmg = find(new RegExp(`-mac-${arch}\\.dmg$`));
    const work = mkdtempSync(join(tmpdir(), "tillbase-dmg-"));
    const mount = join(work, "mount");
    mkdirSync(mount);
    run("hdiutil", ["attach", dmg, "-nobrowse", "-readonly", "-noverify", "-mountpoint", mount]);
    let app;
    try {
      const appName = readdirSync(mount).find((f) => f.endsWith(".app"));
      if (!appName) die(`no .app inside the dmg (found: ${readdirSync(mount).join(", ")})`);
      app = join(work, "Applications", appName);
      mkdirSync(join(work, "Applications"));
      run("ditto", [join(mount, appName), app]); // the same copy a user makes by dragging to Applications
    } finally {
      spawnSync("hdiutil", ["detach", mount, "-force"], { stdio: "inherit" });
    }
    run("codesign", ["--verify", "--deep", "--verbose=2", app]); // ad-hoc or real signature must be intact
    smoke(join(app, "Contents", "MacOS", "Tillbase"));
    break;
  }
  case "appimage": {
    if (process.platform !== "linux") die("the appimage check must run on Linux");
    const appImage = find(/-linux-x86_64\.AppImage$/);
    run("chmod", ["+x", appImage]);
    // CI machines have no FUSE; this makes the AppImage unpack itself to a temp folder and run from there.
    process.env.APPIMAGE_EXTRACT_AND_RUN = "1";
    smoke(appImage);
    break;
  }
  case "deb": {
    if (process.platform !== "linux") die("the deb check must run on Linux");
    const deb = find(/-linux-amd64\.deb$/);
    runAsRoot("apt-get", ["install", "-y", deb]);
    if (!existsSync("/usr/share/applications/tillbase.desktop")) die("the deb did not install a menu entry (tillbase.desktop)");
    smoke("/opt/Tillbase/tillbase");
    break;
  }
  default:
    die("usage: node scripts/smoke-installer.mjs <windows|mac|appimage|deb> [--release dir] [--shots dir]");
}
log("PASSED");
