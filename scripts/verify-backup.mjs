import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const collections = JSON.parse(
  fs.readFileSync(
    new URL("../database/collections.json", import.meta.url),
    "utf8",
  ),
);
export function verify(directory) {
  const root = path.resolve(directory),
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    );
  if (!manifest.complete) throw new Error("Backup is incomplete");
  const documents = {};
  for (const c of collections)
    if (!Object.hasOwn(manifest.collections, c))
      throw new Error("Missing collection " + c);
  for (const [c, count] of Object.entries(manifest.collections)) {
    if (!collections.includes(c)) throw new Error("Unexpected collection");
    const rows = JSON.parse(
      fs.readFileSync(path.join(root, `${c}.json`), "utf8"),
    );
    if (rows.length !== count)
      throw new Error(`Collection count mismatch: ${c}`);
    documents[c] = rows;
  }
  for (const b of manifest.blobs) {
    const resolved = path.resolve(root, b.path);
    if (!resolved.startsWith(root + path.sep))
      throw new Error("Unsafe backup path");
    const bytes = fs.readFileSync(resolved);
    if (
      bytes.length !== b.size ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== b.sha256
    )
      throw new Error(`Corrupt bytes: ${b.revisionId}`);
  }
  for (const r of documents.file_revisions) {
    if (r.lifecycle === "REMOVED") continue;
    const b = manifest.blobs.find((b) => b.revisionId === r._id);
    if (!b || b.sha256 !== r.sha256 || b.size !== r.size)
      throw new Error("File metadata mismatch");
  }
  const revisions = new Set(documents.file_revisions.map((r) => r._id));
  for (const s of documents.submissions)
    if (!revisions.has(s.revisionId))
      throw new Error("Submission revision missing");
  for (const r of documents.reviews)
    if (
      !documents.submissions.some(
        (s) => s._id === r.submissionId && s.revisionId === r.revisionId,
      )
    )
      throw new Error("Review binding corrupted");
  for (const v of documents.file_versions)
    if (!revisions.has(v.currentRevisionId))
      throw new Error("Visible revision missing");
  return { manifest, documents };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!process.argv[2])
    throw new Error("Usage: node scripts/verify-backup.mjs <directory>");
  const r = verify(process.argv[2]);
  console.log(
    `PASS: ${r.manifest.blobs.length} original files and submission/review bindings`,
  );
}
