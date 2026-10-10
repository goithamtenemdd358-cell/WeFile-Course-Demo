"use strict";
const { fresh, check, cas, hash, id, stable } = require("./core");
const MAX = 20 * 1024 * 1024,
  QUOTA = 500 * 1024 * 1024;
const extensions = [
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "pdf",
  "jpg",
  "jpeg",
  "png",
];
function extension(name) {
  return name.split(".").pop().toLowerCase();
}
function validateBytes(name, bytes) {
  const ext = extension(name);
  check(extensions.includes(ext), "UNSUPPORTED_FILE_TYPE");
  check(bytes.length > 0 && bytes.length <= MAX, "FILE_TOO_LARGE");
  const hex = bytes.subarray(0, 8).toString("hex");
  const valid =
    ext === "pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : ["docx", "pptx", "xlsx"].includes(ext)
        ? hex.startsWith("504b0304")
        : ["doc", "ppt", "xls"].includes(ext)
          ? hex === "d0cf11e0a1b11ae1"
          : ext === "png"
            ? hex === "89504e470d0a1a0a"
            : hex.startsWith("ffd8ff");
  check(valid, "UNSUPPORTED_FILE_TYPE", "文件内容与扩展名不一致");
}
async function begin(c, p) {
  check(extensions.includes(extension(p.name)), "UNSUPPORTED_FILE_TYPE");
  if (["AVATAR", "PROJECT_COVER_DRAFT"].includes(p.purpose))
    check(
      ["jpg", "jpeg", "png"].includes(extension(p.name)),
      "UNSUPPORTED_FILE_TYPE",
    );
  const scope = await c.uploadScope(p);
  const budget = await c.get(scope.budgetCollection, scope.budgetId);
  const b = budget.storageBudget || {
    reservedBytes: 0,
    sealedBytes: 0,
    revision: 0,
  };
  check(
    b.reservedBytes + b.sealedBytes + p.sizeHint <= QUOTA,
    "QUOTA_EXCEEDED",
  );
  b.reservedBytes += p.sizeHint;
  b.revision++;
  budget.storageBudget = b;
  await c.db.put(scope.budgetCollection, scope.budgetId, budget);
  const k = fresh();
  const s = {
    _id: k,
    actorId: c.actor,
    ...p,
    ...scope,
    state: "OPEN",
    expiresAt: c.now + 3600000,
    reservationBytes: p.sizeHint,
    tempPath: `staging/${c.actor}/${k}/${p.name.replace(/[^\w.\-]/g, "_")}`,
    sealedRevisionId: null,
  };
  await c.db.put("upload_sessions", k, s);
  return {
    uploadSessionId: k,
    tempPath: s.tempPath,
    expiresAt: s.expiresAt,
    maxBytes: MAX,
    reservedBytes: p.sizeHint,
  };
}
async function acquire(c, p, requestId) {
  const key = id("op", c.actor, requestId),
    fingerprint = hash(
      JSON.stringify(stable({ action: "file.finalizeUpload", p })),
    );
  const old = await c.db.get("operations", key);
  if (old) check(old.payloadHash === fingerprint, "IDEMPOTENCY_CONFLICT");
  const s = await c.get("upload_sessions", p.uploadSessionId);
  check(s.actorId === c.actor);
  await c.uploadScope(s);
  if (s.state === "SEALED") {
    check(
      !s.tempFileId || s.tempFileId === p.tempFileId,
      "IDEMPOTENCY_CONFLICT",
    );
    await c.db.put("operations", key, {
      _id: key,
      actorId: c.actor,
      action: "file.finalizeUpload",
      payloadHash: fingerprint,
      state: "DONE",
      resultRefs: [s.sealedRevisionId],
    });
    return s;
  }
  check(s.expiresAt > c.now, "UPLOAD_NOT_READY");
  check(
    s.state === "OPEN" || (s.state === "SEALING" && s.leaseExpiresAt < c.now),
    "UPLOAD_NOT_READY",
    "文件正在封存，请稍后重试",
  );
  s.attemptRevisionId = fresh();
  s.attemptPath = `sealed/${s.attemptRevisionId}/${s.name.replace(/[^\w.\-]/g, "_")}`;
  s.attempts = s.attempts || [];
  check(
    s.attempts.length < 20,
    "UPLOAD_NOT_READY",
    "封存重试过多，请重新选择文件",
  );
  s.attempts.push({
    revisionId: s.attemptRevisionId,
    path: s.attemptPath,
    createdAt: c.now,
  });
  s.state = "SEALING";
  s.tempFileId = p.tempFileId;
  s.operationId = key;
  s.payloadHash = fingerprint;
  await c.db.put("operations", key, {
    _id: key,
    actorId: c.actor,
    action: "file.finalizeUpload",
    payloadHash: fingerprint,
    state: "PENDING",
  });
  s.leaseToken = fresh();
  s.leaseExpiresAt = c.now + 120000;
  await c.db.put("upload_sessions", s._id, s);
  return s;
}
async function seal(c, p, s, bytes, blobId, revisionId) {
  const current = await c.get("upload_sessions", s._id);
  check(
    current.actorId === c.actor &&
      current.state === "SEALING" &&
      current.leaseToken === s.leaseToken,
    "UPLOAD_NOT_READY",
  );
  await c.uploadScope(s);
  const budget = await c.get(s.budgetCollection, s.budgetId);
  const b = budget.storageBudget;
  check(
    b.sealedBytes + b.reservedBytes - s.reservationBytes + bytes.length <=
      QUOTA,
    "QUOTA_EXCEEDED",
  );
  b.reservedBytes -= s.reservationBytes;
  b.sealedBytes += bytes.length;
  b.revision++;
  await c.db.put(s.budgetCollection, s.budgetId, budget);
  const r = {
    _id: revisionId,
    purpose: s.purpose,
    projectId: s.projectId || null,
    draftKey: s.draftKey || null,
    taskId: s.taskId || null,
    assignmentEpoch: s.assignmentEpoch || null,
    createdBy: c.actor,
    createdAt: c.now,
    blobId,
    name: s.name,
    size: bytes.length,
    sha256: hash(bytes),
    uploadSessionId: s._id,
    lifecycle: "SEALED",
    attached: false,
  };
  await c.db.put("file_revisions", revisionId, r);
  current.state = "SEALED";
  current.sealedRevisionId = revisionId;
  current.chargedBytes = bytes.length;
  await c.db.put("upload_sessions", s._id, current);
  await c.db.put("operations", s.operationId, {
    _id: s.operationId,
    actorId: c.actor,
    action: "file.finalizeUpload",
    payloadHash: s.payloadHash,
    state: "DONE",
    resultRefs: [revisionId],
  });
  return { revisionId, name: r.name, size: r.size, sha256: r.sha256 };
}
async function target(c, p) {
  const x = p.target;
  let rid;
  if (x.kind === "reference") {
    const f = await c.get("files", x.id);
    check(f.scope === "REFERENCE" && !f.deletedAt, "NOT_ACCESSIBLE");
    await c.member(f.projectId);
    rid = f.currentRevisionId;
  } else if (x.kind === "version") {
    const v = await c.get("file_versions", x.id);
    const { t, m } = await c.task(v.taskId, { full: true });
    check(m.role === "LEADER" || t.assignmentEpoch === v.assignmentEpoch);
    rid = v.currentRevisionId;
  } else if (x.kind === "submission") {
    const s = await c.get("submissions", x.id);
    const { t, m } = await c.task(s.taskId, { full: true });
    check(m.role === "LEADER" || t.assignmentEpoch === s.assignmentEpoch);
    rid = s.revisionId;
  } else if (x.kind === "taskDraft") {
    const { t } = await c.task(x.id, { owner: true });
    check(t.draft, "NOT_ACCESSIBLE");
    rid = t.draft.revisionId;
  } else if (x.kind === "projectDraft") {
    const d = await c.draft(x.id);
    rid = x.revisionId;
    check(
      rid &&
        (d.coverRevisionId === rid ||
          d.referenceInputs.some((r) => r.revisionId === rid)),
    );
  } else if (x.kind === "avatar") {
    check(x.id === c.actor);
    rid = (await c.user()).avatarRevisionId;
  } else if (x.kind === "cover") {
    const { p: project } = await c.member(x.id);
    rid = project.coverRevisionId;
  } else check(false, "INVALID_INPUT");
  check(rid, "NOT_ACCESSIBLE");
  if (p.expectedRevisionId)
    check(p.expectedRevisionId === rid, "VERSION_CONFLICT");
  if (x.revisionId) check(x.revisionId === rid, "VERSION_CONFLICT");
  const r = await c.get("file_revisions", rid);
  check(
    ["SEALED", "VISIBLE"].includes(r.lifecycle),
    "NOT_ACCESSIBLE",
    "该次文件已覆盖，审计留存",
  );
  return r;
}
module.exports = { begin, acquire, seal, target, validateBytes, MAX };
