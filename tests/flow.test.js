const test = require("node:test"),
  assert = require("node:assert/strict");
const { setup } = require("./support");
test("three identities: FIRST, reject, KEEP, reject, OVERWRITE, approve; hidden audit bytes", async () => {
  const x = await setup();
  let t = await x.task();
  const summary = await x.call("C", "task.get", { taskId: t.taskId });
  assert.equal(summary.view, "SUMMARY");
  assert.equal(summary.description, undefined);
  assert.equal(summary.capabilities, undefined);
  assert.equal((await x.raw("D", "task.get", { taskId: t.taskId })).ok, false);
  const first = await x.submit(t);
  assert.equal(first.visibleVersion.displayNumber, 1);
  const rejected = await x.reject(first);
  assert.equal(rejected.task.state, "CHANGES_REQUESTED");
  assert.equal(
    (await x.raw("C", "review.get", { reviewId: rejected.reviewId })).ok,
    false,
  );
  const second = await x.submit(rejected.task, "KEEP");
  assert.equal(second.visibleVersion.displayNumber, 2);
  const reject2 = await x.reject(second);
  const third = await x.submit(reject2.task, "OVERWRITE");
  assert.equal(third.visibleVersion.displayNumber, 2);
  assert.equal(third.visibleVersion.versionRevision, 2);
  const versions = await x.call("B", "version.list", { taskId: t.taskId });
  assert.equal(versions.items.length, 2);
  assert.equal(
    versions.items.some((v) => v.revisionId === second.submission.revisionId),
    false,
  );
  for (const who of ["A", "B", "C"])
    assert.equal(
      (
        await x.raw(who, "file.getReadTicket", {
          target: { kind: "submission", id: second.submission.submissionId },
        })
      ).ok,
      false,
    );
  const feedback = await x.call("B", "review.get", {
    reviewId: reject2.reviewId,
  });
  assert.equal(feedback.fileAvailability, "AUDIT_ONLY");
  assert.equal(feedback.originalSubmittedAt, second.submission.submittedAt);
  assert.equal(
    (
      await x.raw("A", "review.approve", {
        submissionId: first.submission.submissionId,
        expectedTaskRevision: third.task.revision,
      })
    ).ok,
    false,
  );
  const approved = await x.call("A", "review.approve", {
    submissionId: third.submission.submissionId,
    expectedTaskRevision: third.task.revision,
  });
  assert.equal(approved.task.state, "DONE");
  assert.equal(
    (await x.call("B", "project.get", { projectId: x.p.projectId })).statistics
      .progress,
    100,
  );
  assert.equal(
    (
      await x.raw("C", "file.getReadTicket", {
        target: { kind: "version", id: third.visibleVersion.visibleVersionId },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await x.call("B", "notification.list", { category: "ALL" })).items.some(
      (n) => n.eventType === "APPROVED",
    ),
    true,
  );
});
test("saved FIRST has no V number; saved OVERWRITE persists through detail submit", async () => {
  const x = await setup(),
    t = await x.task();
  let r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  const saved = await x.call("B", "submission.saveDraft", {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "FIRST",
    expectedTaskRevision: t.revision,
  });
  assert.equal(saved.state, "DOING");
  assert.equal(
    (await x.call("B", "version.list", { taskId: t.taskId })).total,
    0,
  );
  const s = await x.call("B", "submission.submit", {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "FIRST",
    expectedTaskRevision: saved.revision,
  });
  const rejection = await x.reject(s);
  r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  const payload = {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "OVERWRITE",
    baseVersionId: s.visibleVersion.visibleVersionId,
    expectedVersionRevision: 1,
    expectedTaskRevision: rejection.task.revision,
  };
  const draft = await x.call("B", "submission.saveDraft", payload);
  assert.equal(draft.state, "CHANGES_REQUESTED");
  assert.equal(draft.draft.mode, "OVERWRITE");
  const result = await x.call("B", "submission.submit", {
    ...payload,
    expectedTaskRevision: draft.revision,
  });
  assert.equal(result.visibleVersion.displayNumber, 1);
});
test("owner only submits; spoofed identity and cross-project combinations fail", async () => {
  const x = await setup(),
    t = await x.task();
  for (const who of ["A", "C", "D"])
    assert.equal(
      (
        await x.raw(who, "file.beginUpload", {
          purpose: "TASK_DRAFT",
          taskId: t.taskId,
          name: "file.pdf",
          sizeHint: 10,
        })
      ).ok,
      false,
    );
  assert.equal(
    (await x.raw("B", "task.get", { taskId: t.taskId, role: "LEADER" })).ok,
    false,
  );
  assert.equal(
    (
      await x.raw("B", "task.publish", {
        projectId: x.p.projectId,
        fields: {
          title: "伪造",
          dueAt: x.getNow(),
          assigneeId: x.users.B.userId,
        },
      })
    ).ok,
    false,
  );
  const other = await x.project("C");
  assert.equal(
    (
      await x.raw("B", "file.beginUpload", {
        purpose: "TASK_DRAFT",
        taskId: t.taskId,
        projectId: other.projectId,
        name: "file.pdf",
        sizeHint: 10,
      })
    ).ok,
    false,
  );
});
test("idempotency, fingerprint and concurrent review CAS", async () => {
  const x = await setup(),
    t = await x.task();
  const r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  const payload = {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "FIRST",
    expectedTaskRevision: t.revision,
  };
  const results = await Promise.all([
    x.call("B", "submission.submit", payload, "same-request-0001"),
    x.call("B", "submission.submit", payload, "same-request-0001"),
  ]);
  assert.equal(
    results[0].submission.submissionId,
    results[1].submission.submissionId,
  );
  assert.equal(
    (
      await x.raw(
        "B",
        "submission.submit",
        { ...payload, note: "changed" },
        "same-request-0001",
      )
    ).error.code,
    "IDEMPOTENCY_CONFLICT",
  );
  const s = results[0];
  const decisions = await Promise.all([
    x.raw("A", "review.approve", {
      submissionId: s.submission.submissionId,
      expectedTaskRevision: s.task.revision,
    }),
    x.raw("A", "review.reject", {
      submissionId: s.submission.submissionId,
      expectedTaskRevision: s.task.revision,
      reason: "拒绝",
      revisionDueAt: null,
      priority: "NORMAL",
    }),
  ]);
  assert.equal(decisions.filter((r) => r.ok).length, 1);
  assert.equal((await x.db.query("reviews", {})).length, 1);
});
test("reassign resets round, voids pending, isolates previous owner, restarts V1", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t);
  const fields = {
    title: t.title,
    description: t.description,
    requirements: t.requirements,
    dueAt: t.effectiveDueAt,
    assigneeId: x.users.C.userId,
  };
  assert.equal(
    (
      await x.raw("A", "task.update", {
        taskId: t.taskId,
        fields,
        expectedRevision: s.task.revision,
      })
    ).ok,
    false,
  );
  const next = await x.call("A", "task.update", {
    taskId: t.taskId,
    fields,
    expectedRevision: s.task.revision,
    confirmReassign: true,
  });
  assert.equal(next.assignmentEpoch, 2);
  assert.equal(next.currentSubmission, null);
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).view,
    "SUMMARY",
  );
  assert.equal(
    (
      await x.raw("C", "file.getReadTicket", {
        target: { kind: "submission", id: s.submission.submissionId },
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await x.raw("A", "review.approve", {
        submissionId: s.submission.submissionId,
        expectedTaskRevision: next.revision,
      })
    ).ok,
    false,
  );
  const newS = await x.submit(next, "FIRST", "C");
  assert.equal(newS.visibleVersion.displayNumber, 1);
  assert.equal(
    (await x.db.get("submissions", s.submission.submissionId)).decision,
    "VOIDED",
  );
});
test("E12 on-time snapshot stays on-time despite late review", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t);
  x.setNow(x.getNow() + 7200000);
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).isOverdue,
    false,
  );
  const done = await x.call("A", "review.approve", {
    submissionId: s.submission.submissionId,
    expectedTaskRevision: s.task.revision,
  });
  assert.equal(done.task.isOverdue, false);
  const late = await x.task("B", { dueAt: x.getNow() - 1000 });
  assert.equal((await x.submit(late)).task.isOverdue, true);
});
test("project/task drafts stay private; edit drafts do not change published values", async () => {
  const x = await setup();
  let d = await x.call("A", "project.draftOpen", {
    mode: "EDIT",
    projectId: x.p.projectId,
  });
  d = await x.call("A", "project.draftSave", {
    mode: "EDIT",
    draftId: d.draftId,
    fields: { name: "私有编辑", dueAt: x.getNow(), timezone: "Asia/Shanghai" },
    referenceInputs: [],
    expectedDraftRevision: d.draftRevision,
  });
  assert.equal(
    (await x.call("B", "project.get", { projectId: x.p.projectId })).fields
      .name,
    "测试项目",
  );
  assert.equal(
    (
      await x.raw("B", "project.draftGet", {
        mode: "EDIT",
        draftId: d.draftId,
        projectId: x.p.projectId,
      })
    ).ok,
    false,
  );
  const taskDraft = await x.call("A", "task.draftSave", {
    mode: "NEW",
    projectId: x.p.projectId,
    fields: { title: "未分配草稿" },
  });
  assert.equal(
    (
      await x.call("B", "task.list", {
        projectId: x.p.projectId,
        filter: "ALL",
      })
    ).total,
    0,
  );
  assert.equal(
    (await x.call("A", "task.draftList", { projectId: x.p.projectId })).items[0]
      .draftTaskId,
    taskDraft.draftTaskId,
  );
  const updated = await x.call("A", "project.update", {
    projectId: x.p.projectId,
    draftId: d.draftId,
    expectedDraftRevision: d.draftRevision,
    expectedRevision: d.baseProjectRevision,
  });
  assert.equal(updated.fields.name, "私有编辑");
});
test("readAll watermark preserves same-millisecond later notice; rejects other recipient", async () => {
  const x = await setup();
  await x.task();
  const snapshot = await x.call("B", "notification.list", { category: "ALL" });
  await x.task();
  await x.call("B", "notification.readAll", { watermark: snapshot.watermark });
  assert.equal((await x.call("B", "notification.unreadCount")).count, 1);
  assert.equal(
    (
      await x.raw("C", "notification.readAll", {
        watermark: snapshot.watermark,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await x.raw("C", "notification.read", {
        notificationId: snapshot.items[0].notificationId,
      })
    ).ok,
    false,
  );
  const later = await x.call("B", "notification.list", {
    category: "ALL",
    pageSize: 1,
  });
  assert.equal(later.items[0].isRead, false);
  const next = await x.call("B", "notification.list", {
    category: "ALL",
    pageSize: 1,
    cursor: later.nextCursor,
  });
  assert.equal(next.items[0].isRead, true);
});
test("manual and scheduled reminders deduplicate and stop after submission", async () => {
  const x = await setup(),
    t = await x.task();
  await x.call("A", "task.remind", { taskId: t.taskId });
  assert.equal(
    (await x.raw("A", "task.remind", { taskId: t.taskId })).error.code,
    "RATE_LIMITED",
  );
  assert.equal((await x.service.reminders()).created, 1);
  assert.equal((await x.service.reminders()).created, 0);
  await x.submit(t);
  x.setNow(x.getNow() + 7200000);
  assert.equal((await x.service.reminders()).created, 0);
});
test("public references remain separate; deletion revokes new ticket", async () => {
  const x = await setup();
  const r = await x.upload("A", {
    purpose: "PROJECT_REFERENCE",
    projectId: x.p.projectId,
  });
  const f = await x.call("A", "reference.create", {
    projectId: x.p.projectId,
    revisionId: r.revisionId,
    category: "REFERENCE",
    description: "公共资料",
  });
  assert.ok(
    (
      await x.call("C", "file.getReadTicket", {
        target: { kind: "reference", id: f.referenceId },
      })
    ).downloadUrl,
  );
  assert.equal(
    (
      await x.raw("D", "file.getReadTicket", {
        target: { kind: "reference", id: f.referenceId },
      })
    ).ok,
    false,
  );
  await x.call("A", "reference.delete", {
    projectId: x.p.projectId,
    referenceId: f.referenceId,
    expectedRevision: f.revision,
  });
  assert.equal(
    (
      await x.raw("B", "file.getReadTicket", {
        target: { kind: "reference", id: f.referenceId },
      })
    ).ok,
    false,
  );
});
test("storage failure does not change task; original binary SHA-256 survives", async () => {
  const x = await setup(),
    t = await x.task();
  x.storage.failSeal = true;
  const plan = await x.call("B", "file.beginUpload", {
    purpose: "TASK_DRAFT",
    taskId: t.taskId,
    name: "file.pdf",
    sizeHint: 20,
  });
  const fileId = "test://" + plan.tempPath,
    bytes = Buffer.concat([
      Buffer.from("%PDF-1.7"),
      Buffer.from([0, 255, 128, 7]),
    ]);
  x.storage.blobs.set(fileId, bytes);
  assert.equal(
    (
      await x.raw("B", "file.finalizeUpload", {
        uploadSessionId: plan.uploadSessionId,
        tempFileId: fileId,
      })
    ).ok,
    false,
  );
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).state,
    "TODO",
  );
  x.storage.failSeal = false;
  const r = await x.call("B", "file.finalizeUpload", {
    uploadSessionId: plan.uploadSessionId,
    tempFileId: fileId,
  });
  assert.equal(r.sha256, x.hash(bytes));
  assert.deepEqual(x.storage.blobs.get(x.storage.sealed[0]), bytes);
});
test("notification failure rolls back submission, versions and state", async () => {
  const x = await setup(),
    t = await x.task();
  const r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  x.db.failCollection = "notifications";
  const result = await x.raw("B", "submission.submit", {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "FIRST",
    expectedTaskRevision: t.revision,
  });
  assert.equal(result.ok, false);
  x.db.failCollection = null;
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).state,
    "TODO",
  );
  assert.equal(
    (await x.call("B", "version.list", { taskId: t.taskId })).total,
    0,
  );
});
test("soft delete hides task, cancels review, retains bytes, revokes read", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t);
  await x.call("A", "task.delete", {
    taskId: t.taskId,
    expectedRevision: s.task.revision,
  });
  assert.equal((await x.raw("B", "task.get", { taskId: t.taskId })).ok, false);
  assert.equal(
    (
      await x.raw("A", "file.getReadTicket", {
        target: { kind: "submission", id: s.submission.submissionId },
      })
    ).ok,
    false,
  );
  assert.equal(
    (await x.call("A", "project.get", { projectId: x.p.projectId })).statistics
      .total,
    0,
  );
  assert.equal(
    (await x.db.get("submissions", s.submission.submissionId)).decision,
    "VOIDED",
  );
  assert.equal(x.storage.sealed.length, 1);
});
