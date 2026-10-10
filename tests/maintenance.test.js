const test = require("node:test"),
  assert = require("node:assert/strict");
const { setup } = require("./support");
const { cleanup } = require("../shared/maintenance");
test("cleanup is dry-run by default and never deletes an attached draft or covered audit revision", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t),
    reject = await x.reject(s);
  await x.submit(reject.task, "OVERWRITE");
  x.setNow(x.getNow() + 3 * 86400000);
  const report = await cleanup(x.db, {}, { now: x.getNow() });
  assert.equal(report.apply, false);
  assert.equal(report.revisionCandidates.length, 0);
  assert.equal(x.storage.sealed.length, 2);
});
test("cleanup storage failure retains quota; success releases once; repeated cleanup is safe", async () => {
  const x = await setup(),
    t = await x.task(),
    r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  x.setNow(x.getNow() + 3 * 86400000);
  const before = (await x.db.get("projects", x.p.projectId)).storageBudget
    .sealedBytes;
  let fails = true;
  const storage = {
    async remove(key) {
      if (fails) throw new Error("delete failed");
      x.storage.blobs.delete(key);
    },
    fileIdForPath: (p) => "test://" + p,
  };
  const bad = await cleanup(x.db, storage, { now: x.getNow(), apply: true });
  assert.equal(bad.failures.length, 2); // staging and never-attached sealed object both failed
  assert.ok(bad.failures.some((f) => f.id === r.revisionId));
  assert.equal(
    (await x.db.get("projects", x.p.projectId)).storageBudget.sealedBytes,
    before,
  );
  fails = false;
  const good = await cleanup(x.db, storage, { now: x.getNow(), apply: true });
  assert.equal(good.removed.length, 2);
  assert.ok(good.removed.includes(r.revisionId));
  assert.equal(
    (await x.db.get("projects", x.p.projectId)).storageBudget.sealedBytes,
    0,
  );
  assert.equal(
    (await cleanup(x.db, storage, { now: x.getNow(), apply: true })).removed
      .length,
    0,
  );
  assert.equal(
    (
      await x.raw("B", "submission.saveDraft", {
        taskId: t.taskId,
        revisionId: r.revisionId,
        mode: "FIRST",
        expectedTaskRevision: t.revision,
      })
    ).ok,
    false,
  );
});
test("expired reservation cleanup releases once, follows published draft budget and rejects finalize race", async () => {
  const x = await setup();
  let d = await x.call("C", "project.draftOpen", { mode: "NEW" });
  const plan = await x.call("C", "file.beginUpload", {
    purpose: "PROJECT_REFERENCE_DRAFT",
    draftKey: d.draftKey,
    name: "ref.pdf",
    sizeHint: 16,
  });
  d = await x.call("C", "project.draftSave", {
    mode: "NEW",
    draftId: d.draftId,
    fields: { name: "P", dueAt: x.getNow() + 1000, timezone: "Asia/Shanghai" },
    referenceInputs: [],
    expectedDraftRevision: d.draftRevision,
  });
  const p = await x.call("C", "project.publish", {
    draftId: d.draftId,
    expectedDraftRevision: d.draftRevision,
  });
  await x.call("C", "project.draftOpen", { mode: "NEW" });
  assert.equal(
    (await x.db.get("projects", p.projectId)).storageBudget.reservedBytes,
    16,
  );
  x.setNow(x.getNow() + 3 * 86400000);
  const storage = { async remove() {}, fileIdForPath: (p) => "test://" + p };
  await cleanup(x.db, storage, { now: x.getNow(), apply: true });
  assert.equal(
    (await x.db.get("projects", p.projectId)).storageBudget.reservedBytes,
    0,
  );
  assert.equal(
    (
      await x.raw("C", "file.finalizeUpload", {
        uploadSessionId: plan.uploadSessionId,
        tempFileId: "test://" + plan.tempPath,
      })
    ).ok,
    false,
  );
});
test("maintenance mode permits existing reads but rejects all business writes and reminders", async () => {
  const x = await setup();
  x.service.readOnly = true;
  assert.ok(
    (await x.call("A", "project.get", { projectId: x.p.projectId })).projectId,
  );
  assert.equal(
    (await x.raw("A", "project.draftOpen", { mode: "NEW" })).ok,
    false,
  );
  await assert.rejects(x.service.reminders());
});
test("storage rule denies all direct reads and every sealed write including original uploader", () => {
  const vm = require("node:vm"),
    fs = require("node:fs");
  const r = JSON.parse(fs.readFileSync("storage/rules.json", "utf8"));
  assert.equal(r.read, false);
  const run = (path, owner = "B", auth = "B") =>
    vm.runInNewContext(r.write, {
      resource: { path, openid: owner },
      auth: { openid: auth },
    });
  assert.equal(run("staging/u/file"), true);
  assert.equal(run("sealed/u/file"), false);
  assert.equal(run("staging/u/file", "B", "C"), false);
});
