import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const dirs = ["shared", "miniprogram", "cloudfunctions", "scripts", "tests", "server"];
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.name === "node_modules"
        ? []
        : e.isDirectory()
          ? walk(path.join(dir, e.name))
          : [path.join(dir, e.name)],
    );
}
const source = dirs.flatMap(walk).filter((f) => /\.(js|mjs|cjs)$/.test(f));
for (const file of source) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(r.status || 1);
  }
}
const tests = fs
  .readdirSync("tests")
  .filter((f) => f.endsWith(".test.js"))
  .map((f) => `tests/${f}`);
const r = spawnSync(
  process.execPath,
  ["--test", "--test-reporter=tap", ...tests],
  { encoding: "utf8", windowsHide: true },
);
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync("artifacts/local-tests.tap", r.stdout + r.stderr);
const count = Number((r.stdout.match(/^# tests (\d+)/m) || [])[1] || 0),
  passed = Number((r.stdout.match(/^# pass (\d+)/m) || [])[1] || 0),
  failed = Number((r.stdout.match(/^# fail (\d+)/m) || [])[1] || 0);
const report = {
  at: new Date().toISOString(),
  status: r.status === 0 ? "PASS" : "FAIL",
  syntaxFiles: source.length,
  tests: count,
  passed,
  failed,
  scope:
    "Application tests with test adapters plus real loopback HTTP, SQLite and filesystem tests; synthetic test identities, not multi-account WeChat acceptance",
  files: tests,
};
fs.writeFileSync(
  "docs/LOCAL_TEST_RESULT.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (r.status !== 0) console.error(r.stdout + r.stderr);
process.exitCode = r.status || 0;
