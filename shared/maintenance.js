"use strict";
const { check } = require("./core");
async function budgetTarget(tx, s) {
  let collection = s.budgetCollection,
    key = s.budgetId;
  let b = await tx.get(collection, key);
  if (
    collection === "projects" &&
    b &&
    b.status === "CONSUMED" &&
    b.publishedProjectId
  ) {
    key = b.publishedProjectId;
    b = await tx.get(collection, key);
  }
  check(b && b.storageBudget, "INTERNAL_ERROR", "Upload budget owner missing");
  return { collection, key, b };
}
async function cleanup(
  db,
  storage,
  { now = Date.now(), graceMs = 86400000, apply = false } = {},
) {
  const revisions = (await db.query("file_revisions", {})).filter(
    (r) =>
      r.attached === false &&
      ["SEALED", "GC_PENDING"].includes(r.lifecycle) &&
      r.createdAt < now - graceMs,
  );
  const sessions = (await db.query("upload_sessions", {})).filter(
    (s) =>
      !s.sealedRevisionId &&
      ["OPEN", "SEALING", "CLEANING"].includes(s.state) &&
      s.expiresAt < now - graceMs &&
      (!s.leaseExpiresAt || s.leaseExpiresAt < now),
  );
  const allSessions = await db.query("upload_sessions", {});
  const orphanAttempts = [];
  for (const s of allSessions) {
    if (s.state !== "SEALED" && s.expiresAt >= now - graceMs) continue;
    if (s.state === "SEALING" && s.leaseExpiresAt > now) continue;
    for (const a of s.attempts || []) {
      if (
        a.revisionId !== s.sealedRevisionId &&
        !a.cleanedAt &&
        a.createdAt < now - graceMs &&
        !(await db.get("file_revisions", a.revisionId))
      )
        orphanAttempts.push({ sessionId: s._id, revisionId: a.revisionId });
    }
  }
  const staging = allSessions.filter(
    (s) =>
      s.state === "SEALED" && !s.tempCleanedAt && s.expiresAt < now - graceMs,
  );
  const report = {
    apply,
    orphanAttempts,
    stagingCandidates: staging.map((s) => s._id),
    revisionCandidates: revisions.map((r) => r._id),
    sessionCandidates: sessions.map((s) => s._id),
    removed: [],
    failures: [],
  };
  if (!apply) return report;
  for (const item of orphanAttempts) {
    try {
      const candidate = await db.transaction(async (tx) => {
        const s = await tx.get("upload_sessions", item.sessionId);
        if (
          (s.state !== "SEALED" && s.expiresAt >= now - graceMs) ||
          (s.state === "SEALING" && s.leaseExpiresAt > now)
        )
          return null;
        if (await tx.get("file_revisions", item.revisionId)) return null;
        const a = s.attempts.find((a) => a.revisionId === item.revisionId);
        if (!a || a.cleanedAt) return null;
        if (s.state !== "SEALED" && s.state !== "EXPIRED") s.state = "CLEANING";
        a.cleanupState = "CLEANING";
        await tx.put("upload_sessions", s._id, s);
        return a;
      });
      if (!candidate) continue;
      await storage.remove(
        candidate.blobId || storage.fileIdForPath(candidate.path),
      );
      await db.transaction(async (tx) => {
        const s = await tx.get("upload_sessions", item.sessionId);
        const a = s.attempts.find((a) => a.revisionId === item.revisionId);
        a.cleanedAt = now;
        a.cleanupState = "REMOVED";
        await tx.put("upload_sessions", s._id, s);
      });
      report.removed.push(item.revisionId);
    } catch (e) {
      report.failures.push({ id: item.revisionId, message: e.message });
    }
  }
  for (const candidate of staging) {
    try {
      await storage.remove(
        candidate.tempFileId || storage.fileIdForPath(candidate.tempPath),
      );
      await db.transaction(async (tx) => {
        const s = await tx.get("upload_sessions", candidate._id);
        s.tempCleanedAt = now;
        await tx.put("upload_sessions", s._id, s);
      });
      report.removed.push("staging:" + candidate._id);
    } catch (e) {
      report.failures.push({ id: candidate._id, message: e.message });
    }
  }
  for (const candidate of revisions) {
    try {
      const item = await db.transaction(async (tx) => {
        const r = await tx.get("file_revisions", candidate._id);
        if (!r || r.attached || !["SEALED", "GC_PENDING"].includes(r.lifecycle))
          return null;
        const s = await tx.get("upload_sessions", r.uploadSessionId);
        if (!s || (s.leaseExpiresAt > now && s.state === "SEALING"))
          return null;
        r.lifecycle = "GC_PENDING";
        await tx.put("file_revisions", r._id, r);
        return r;
      });
      if (!item) continue;
      await storage.remove(item.blobId);
      await db.transaction(async (tx) => {
        const r = await tx.get("file_revisions", item._id);
        if (r.lifecycle === "REMOVED") return;
        check(r.lifecycle === "GC_PENDING" && !r.attached);
        const s = await tx.get("upload_sessions", r.uploadSessionId);
        const { collection, key, b } = await budgetTarget(tx, s);
        check(b.storageBudget.sealedBytes >= s.chargedBytes, "INTERNAL_ERROR");
        b.storageBudget.sealedBytes -= s.chargedBytes;
        b.storageBudget.revision++;
        s.chargedBytes = 0;
        s.accountingState = "RELEASED";
        r.lifecycle = "REMOVED";
        await tx.put(collection, key, b);
        await tx.put("upload_sessions", s._id, s);
        await tx.put("file_revisions", r._id, r);
      });
      report.removed.push(item._id);
    } catch (e) {
      report.failures.push({ id: candidate._id, message: e.message });
    }
  }
  for (const candidate of sessions) {
    try {
      const s = await db.transaction(async (tx) => {
        const current = await tx.get("upload_sessions", candidate._id);
        if (
          !current ||
          current.sealedRevisionId ||
          !["OPEN", "SEALING", "CLEANING"].includes(current.state) ||
          current.leaseExpiresAt > now
        )
          return null;
        current.state = "CLEANING";
        await tx.put("upload_sessions", current._id, current);
        return current;
      });
      if (!s) continue;
      if (
        (s.attempts || []).some(
          (a) => a.revisionId !== s.sealedRevisionId && !a.cleanedAt,
        )
      )
        throw new Error("Orphan attempts remain; reservation retained");
      await storage.remove(s.tempFileId || storage.fileIdForPath(s.tempPath));
      await db.transaction(async (tx) => {
        const current = await tx.get("upload_sessions", s._id);
        if (current.state === "EXPIRED") return;
        check(current.state === "CLEANING");
        const { collection, key, b } = await budgetTarget(tx, current);
        check(
          b.storageBudget.reservedBytes >= current.reservationBytes,
          "INTERNAL_ERROR",
        );
        b.storageBudget.reservedBytes -= current.reservationBytes;
        b.storageBudget.revision++;
        current.reservationBytes = 0;
        current.accountingState = "RELEASED";
        current.state = "EXPIRED";
        await tx.put(collection, key, b);
        await tx.put("upload_sessions", s._id, current);
      });
      report.removed.push(s._id);
    } catch (e) {
      report.failures.push({ id: candidate._id, message: e.message });
    }
  }
  return report;
}
module.exports = { cleanup, budgetTarget };
