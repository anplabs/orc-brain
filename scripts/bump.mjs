// Lockstep version bump for the monorepo. All packages (including the
// private UI) share one version; inter-package deps are `workspace:*`, so
// pnpm rewrites them at publish time and only the `version` fields matter.
//
// Usage:  pnpm bump patch | minor | major | <x.y.z>
//
// Bumps the root package.json and every packages/*/package.json, then prints
// the release checklist (commit → tag → push). It never touches git itself.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function fail(message) {
  console.error(`bump: ${message}`);
  process.exit(1);
}

const arg = process.argv[2];
if (!arg) fail("usage: pnpm bump patch|minor|major|<x.y.z>");

const rootPkgPath = join(ROOT, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const current = rootPkg.version;

function nextVersion(from, spec) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(from);
  if (!m) fail(`current version "${from}" is not plain x.y.z`);
  const [major, minor, patch] = m.slice(1).map(Number);
  switch (spec) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      if (!/^\d+\.\d+\.\d+$/.test(spec)) {
        fail(`"${spec}" is not patch|minor|major or a plain x.y.z version`);
      }
      return spec;
  }
}

const next = nextVersion(current, arg);
if (next === current) fail(`already at ${current}`);

const packageFiles = [
  rootPkgPath,
  ...readdirSync(join(ROOT, "packages")).map((dir) =>
    join(ROOT, "packages", dir, "package.json"),
  ),
];

for (const file of packageFiles) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version !== current) {
    fail(`${file} is at ${pkg.version}, expected ${current} — lockstep broken`);
  }
  pkg.version = next;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${pkg.name} ${current} → ${next}`);
}

console.log(`
Bumped ${packageFiles.length} packages to ${next}. Next steps:

  git switch -c release/v${next}
  git commit -am "Release v${next}"
  git push -u origin release/v${next}   # open a PR, let CI go green, merge
  git switch main && git pull
  git tag v${next} && git push origin v${next}   # triggers the Release workflow
`);
