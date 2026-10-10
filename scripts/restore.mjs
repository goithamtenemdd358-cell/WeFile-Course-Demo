import fs from "node:fs";
import path from "node:path";
import { admin, collections } from "./admin.mjs";
import { verify } from "./verify-backup.mjs";
if (process.argv.includes("--help")) {
  console.log(
    "node scripts/restore.mjs <backup-directory> [--apply --confirm-env=<new-empty-env>]. Dry-run verifies backup. Apply refuses source environment or ANY existing target documents. Requires explicit operator authorization.",
  );
  process.exit(0);
}
const dir = process.argv[2];
if (!dir) throw new Error("Backup directory required");
const { manifest, documents } = verify(dir);
if (!process.argv.includes("--apply")) {
  console.log("Backup valid; dry-run only. No cloud writes.");
  process.exit(0);
}
const { app, db, env } = admin();
if (
  env === manifest.environment ||
  !process.argv.includes(`--confirm-env=${env}`)
)
  throw new Error(
    "Use a different explicitly confirmed empty test environment",
  );
for (const c of collections) {
  const existing = await app.database().collection(c).limit(1).get();
  if (existing.data.length) throw new Error(`Target must be empty: ${c}`);
}
const stamp = Date.now();
for (const r of documents.file_revisions) {
  if (r.lifecycle === "REMOVED") continue;
  const b = manifest.blobs.find((b) => b.revisionId === r._id);
  if (!b) throw new Error(`Missing original file: ${r._id}`);
  const result = await app.uploadFile({
    cloudPath: `sealed/restore-${stamp}/${r._id}/${r.name.replace(/[^\w.\-]/g, "_")}`,
    fileContent: fs.readFileSync(path.resolve(dir, b.path)),
  });
  r.blobId = result.fileID;
}
// In-progress staging was never a delivered file; expire it and release only its reservation.
for (const s of documents.upload_sessions) {
  if (!s.sealedRevisionId) {
    let budget = documents[s.budgetCollection].find(
      (d) => d._id === s.budgetId,
    );
    if (budget && budget.publishedProjectId)
      budget = documents.projects.find(
        (p) => p._id === budget.publishedProjectId,
      );
    if (budget && budget.storageBudget)
      budget.storageBudget.reservedBytes = Math.max(
        0,
        budget.storageBudget.reservedBytes - s.reservationBytes,
      );
    s.reservationBytes = 0;
    s.state = "EXPIRED";
    s.accountingState = "RELEASED";
  }
  s.tempFileId = null;
}
for (const c of collections)
  for (const row of documents[c]) await db.put(c, row._id, row);
console.log(
  `Restored into ${env}. Reapply private rules before user access; run three-account acceptance. Source environment was not modified.`,
);
