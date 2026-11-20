// electron-builder "afterPack" hook: ad-hoc sign the macOS app.
//
// We have no Apple Developer certificate yet, so releases are not signed by an identified developer
// (see docs/RELEASING.md). An app with a broken or missing signature can be killed on Apple Silicon,
// so after electron-builder has changed the app (icon, Info.plist, asar) we re-seal it with an
// "ad-hoc" signature ("-"), which needs no certificate and makes the bundle internally consistent.
// This does NOT make Gatekeeper trust the app: downloaded copies still need the user to approve them.
//
// When a real certificate is added later, delete this hook and set mac.identity (or CSC_LINK / CSC_NAME).
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function adhocSign(context) {
  console.log("  • afterPack hook ran for " + context.electronPlatformName);
  if (context.electronPlatformName !== "darwin") return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
