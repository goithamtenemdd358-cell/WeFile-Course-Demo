import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { admin, collections } from "./admin.mjs";
if (process.argv.includes("--help")) {
  console.log(
    "node scripts/backup.mjs --quiesced (read-only cloud export; requires env credentials; writes backups/<timestamp>/). Enable WEFILE_READ_ONLY on BOTH functions and pause cleanup before confirming quiesced.",
  );
  process.exit(0);
}
if (!process.argv.includes("--quiesced"))
  throw new Error(
    "First freeze business writes and pause reminders/cleanup; then pass --quiesced.",
  );
const { app, db, env } = admin(),
  directory = path.resolve(
    "backups",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
fs.mkdirSync(path.join(directory, "blobs"), { recursive: true });
const manifest = {
  version: 1,
  environment: env,
  createdAt: new Date().toISOString(),
  quiesced: true,
  complete: false,
  collections: {},
  blobs: [],
};
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
for (const name of collections) {
  const rows = await db.query(name, {});
  fs.writeFileSync(
    path.join(directory, `${name}.json`),
    JSON.stringify(rows, null, 2),
  );
  manifest.collections[name] = rows.length;
}
const revisions = JSON.parse(
  fs.readFileSync(path.join(directory, "file_revisions.json"), "utf8"),
);
for (const r of revisions) {
  if (r.lifecycle === "REMOVED") continue;
  const file = await app.downloadFile({ fileID: r.blobId });
  const bytes = Buffer.from(file.fileContent);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== r.sha256 || bytes.length !== r.size)
    throw new Error(`Integrity mismatch: ${r._id}`);
  const relative = `blobs/${r._id}.bin`;
  fs.writeFileSync(path.join(directory, relative), bytes);
  manifest.blobs.push({
    revisionId: r._id,
    path: relative,
    size: bytes.length,
    sha256: digest,
  });
}
manifest.complete = true;
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log(
  `Backup complete: ${directory}; ${manifest.blobs.length} original files including audit revisions.`,
);
