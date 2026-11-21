// Fails if package-lock.json asks npm to fetch anything over git (git+ssh, git+https, git://, github:).
//
// Why: npm 11 refuses git dependencies by default (EALLOWGIT), and a git+ssh URL cannot work for a
// person who has no SSH key for GitHub. A fresh `npm ci` then fails on their machine even though it
// works on ours, because we already have the packages cached. Everything must come from the npm
// registry (https://registry.npmjs.org/...).
//
//   node scripts/check-lockfile.mjs [path/to/package-lock.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const file = resolve(process.argv[2] ?? resolve(root, "package-lock.json"));

// Anything that is not a plain registry download.
const gitLike = /^(git\+|git:|git@|ssh:|github:|gitlab:|bitbucket:|gist:)/i;
const isGit = (value) => typeof value === "string" && gitLike.test(value.trim());

let lock;
try {
  lock = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`Cannot read ${file}: ${e.message}`);
  process.exit(2);
}

const bad = [];
for (const [where, pkg] of Object.entries(lock.packages ?? {})) {
  const name = where === "" ? "(root)" : where;
  if (isGit(pkg.resolved)) bad.push(`${name}: resolved ${pkg.resolved}`);
  if (isGit(pkg.version)) bad.push(`${name}: version ${pkg.version}`);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (isGit(spec)) bad.push(`${name}: ${field}.${dep} = ${spec}`);
    }
  }
}
// Older lockfile format.
const walk = (deps, trail) => {
  for (const [dep, d] of Object.entries(deps ?? {})) {
    if (isGit(d.resolved) || isGit(d.version)) bad.push(`${trail}${dep}: ${d.resolved ?? d.version}`);
    walk(d.dependencies, `${trail}${dep} > `);
  }
};
walk(lock.dependencies, "");

const count = Object.keys(lock.packages ?? lock.dependencies ?? {}).length;
if (bad.length > 0) {
  console.error(`package-lock.json pulls ${bad.length} thing(s) over git. Use the npm registry version instead:`);
  for (const line of bad) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`OK: ${count} entries in ${file.replace(root, ".")}, none fetched over git.`);
