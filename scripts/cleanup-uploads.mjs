import fs from "node:fs";
import { createRequire } from "node:module";
import { admin } from "./admin.mjs";
const require = createRequire(import.meta.url);
const { cleanup } = require("../shared/maintenance");
const apply = process.argv.includes("--apply");
if (process.argv.includes("--help")) {
  console.log(
    "Default: dry-run with admin credentials. --apply --confirm-env=<ID> performs deletion of expired, never-attached uploads only; explicit authorization required.",
  );
  process.exit(0);
}
const { db, storage, env } = admin();
if (apply && !process.argv.includes(`--confirm-env=${env}`))
  throw new Error("Explicit --confirm-env must match configured environment");
const report = await cleanup(db, storage, { apply });
fs.mkdirSync("artifacts", { recursive: true });
fs.writeFileSync(
  "artifacts/cleanup-report.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    apply,
    candidates:
      report.revisionCandidates.length + report.sessionCandidates.length,
    removed: report.removed.length,
    failures: report.failures.length,
  }),
);
if (report.failures.length) process.exitCode = 1;
