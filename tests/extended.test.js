const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { setup } = require("./support");
test("backup verifier checks original and audit bytes plus immutable review bindings", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t),
    r = await x.reject(s);
  await x.submit(r.task, "OVERWRITE");
  fs.mkdirSync("artifacts", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("artifacts/backup-test-"));
  fs.mkdirSync(path.join(dir, "blobs"));
  const collections = require("../database/collections.json"),
    manifest = { complete: true, collections: {}, blobs: [] };
  for (const c of collections) {
    const rows = await x.db.query(c, {});
    manifest.collections[c] = rows.length;
    fs.writeFileSync(path.join(dir, c + ".json"), JSON.stringify(rows));
  }
  for (const rev of await x.db.query("file_revisions", {})) {
    const relative = "blobs/" + rev._id + ".bin",
      bytes = x.storage.blobs.get(rev.blobId);
    fs.writeFileSync(path.join(dir, relative), bytes);
    manifest.blobs.push({
      revisionId: rev._id,
      path: relative,
      size: rev.size,
      sha256: rev.sha256,
    });
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const { verify } = await import("../scripts/verify-backup.mjs");
  const result = verify(dir);
  assert.equal(result.manifest.blobs.length, 2);
  assert.equal(
    result.documents.file_revisions.some((r) => r.lifecycle === "AUDIT_ONLY"),
    true,
  );
  const filename = path.join(dir, manifest.blobs[0].path),
    bytes = fs.readFileSync(filename);
  fs.writeFileSync(filename, Buffer.from("corrupt"));
  assert.throws(() => verify(dir), /Corrupt/);
  fs.writeFileSync(filename, bytes);
  const reviews = JSON.parse(fs.readFileSync(path.join(dir, "reviews.json")));
  reviews[0].revisionId = "wrong-revision";
  fs.writeFileSync(path.join(dir, "reviews.json"), JSON.stringify(reviews));
  assert.throws(() => verify(dir), /binding/);
});
test("scheduled reminders regenerate only when due revision changes, never from historical lateness", async () => {
  const x = await setup(),
    t = await x.task();
  assert.equal((await x.service.reminders()).created, 1);
  const fields = {
    title: t.title,
    assigneeId: x.users.B.userId,
    dueAt: t.effectiveDueAt + 1000,
  };
  await x.call("A", "task.update", {
    taskId: t.taskId,
    fields,
    expectedRevision: t.revision,
  });
  assert.equal((await x.service.reminders()).created, 1);
  assert.equal((await x.service.reminders()).created, 0);
  x.setNow(x.getNow() + 7200000);
  assert.equal((await x.service.reminders()).created, 1);
  assert.equal((await x.service.reminders()).created, 0);
});
test("competing OVERWRITE requests cannot double-increment or lose evidence", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t),
    r = await x.reject(s);
  const [a, b] = await Promise.all([
    x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId }),
    x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId }),
  ]);
  const payload = {
    taskId: t.taskId,
    mode: "OVERWRITE",
    baseVersionId: s.visibleVersion.visibleVersionId,
    expectedVersionRevision: 1,
    expectedTaskRevision: r.task.revision,
  };
  const results = await Promise.all([
    x.raw("B", "submission.submit", { ...payload, revisionId: a.revisionId }),
    x.raw("B", "submission.submit", { ...payload, revisionId: b.revisionId }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(
    (await x.call("B", "version.list", { taskId: t.taskId })).items[0]
      .versionRevision,
    2,
  );
  assert.equal(
    (await x.db.query("submissions", { taskId: t.taskId })).length,
    2,
  );
  assert.equal(
    (await x.db.get("file_revisions", s.submission.revisionId)).lifecycle,
    "AUDIT_ONLY",
  );
});
test("17 context holds original task requirements even after manager edits latest text", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t);
  await x.call("A", "task.update", {
    taskId: t.taskId,
    fields: {
      title: "new title",
      description: "new requirements",
      requirements: "changed",
      assigneeId: x.users.B.userId,
      dueAt: t.effectiveDueAt,
    },
    expectedRevision: s.task.revision,
  });
  const ctx = await x.call("A", "review.context", {
    submissionId: s.submission.submissionId,
  });
  assert.equal(ctx.taskRequirementsSnapshot.description, "私有说明");
  assert.equal(ctx.taskRequirementsSnapshot.title, "任务");
  assert.equal(ctx.canReview, true);
});
test("storage lease and membership are rechecked at finalize; abandoned attempt is inventoried", async () => {
  const x = await setup(),
    t = await x.task();
  const plan = await x.call("B", "file.beginUpload", {
    purpose: "TASK_DRAFT",
    taskId: t.taskId,
    name: "x.pdf",
    sizeHint: 20,
  });
  await x.call("A", "task.update", {
    taskId: t.taskId,
    fields: {
      title: t.title,
      assigneeId: x.users.C.userId,
      dueAt: t.effectiveDueAt,
    },
    expectedRevision: t.revision,
    confirmReassign: true,
  });
  assert.equal(
    (
      await x.raw("B", "file.finalizeUpload", {
        uploadSessionId: plan.uploadSessionId,
        tempFileId: "test://" + plan.tempPath,
      })
    ).ok,
    false,
  );
});
