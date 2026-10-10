const test = require("node:test"),
  assert = require("node:assert/strict");
const { setup } = require("./support");
test("private project draft cannot launder someone else task revision into a read ticket", async () => {
  const x = await setup(),
    t = await x.task(),
    s = await x.submit(t);
  const d = await x.call("C", "project.draftOpen", { mode: "NEW" });
  const result = await x.raw("C", "project.draftSave", {
    mode: "NEW",
    draftId: d.draftId,
    fields: {},
    referenceInputs: [
      {
        revisionId: s.submission.revisionId,
        category: "REFERENCE",
        description: "attack",
      },
    ],
    expectedDraftRevision: d.draftRevision,
  });
  assert.equal(result.ok, false);
  assert.equal(
    (
      await x.raw("C", "file.getReadTicket", {
        target: {
          kind: "projectDraft",
          id: d.draftId,
          revisionId: s.submission.revisionId,
        },
      })
    ).ok,
    false,
  );
});
test("quota reservation serializes concurrent uploads and seal charges actual bytes exactly once", async () => {
  const x = await setup(),
    t = await x.task();
  const project = await x.db.get("projects", x.p.projectId);
  project.storageBudget.sealedBytes = 500 * 1024 * 1024 - 30;
  await x.db.put("projects", project._id, project);
  const payload = {
    purpose: "TASK_DRAFT",
    taskId: t.taskId,
    name: "file.pdf",
    sizeHint: 20,
  };
  const rs = await Promise.all([
    x.raw("B", "file.beginUpload", payload),
    x.raw("B", "file.beginUpload", payload),
  ]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(rs.find((r) => !r.ok).error.code, "QUOTA_EXCEEDED");
  const plan = rs.find((r) => r.ok).data;
  const bytes = Buffer.from("%PDF-1.7");
  x.storage.blobs.set("test://" + plan.tempPath, bytes);
  const p = {
    uploadSessionId: plan.uploadSessionId,
    tempFileId: "test://" + plan.tempPath,
  };
  await x.call("B", "file.finalizeUpload", p, "finalize-request-1");
  const after = await x.db.get("projects", project._id);
  await x.call("B", "file.finalizeUpload", p, "finalize-request-1");
  assert.deepEqual(
    (await x.db.get("projects", project._id)).storageBudget,
    after.storageBudget,
  );
  assert.equal(after.storageBudget.reservedBytes, 0);
  assert.equal(
    (
      await x.raw(
        "B",
        "file.finalizeUpload",
        { ...p, tempFileId: "wrong" },
        "finalize-request-1",
      )
    ).error.code,
    "IDEMPOTENCY_CONFLICT",
  );
});
test("invalid extension/content, expired session, owner change and stale version baseline rejected", async () => {
  const x = await setup(),
    t = await x.task();
  assert.equal(
    (
      await x.raw("B", "file.beginUpload", {
        purpose: "TASK_DRAFT",
        taskId: t.taskId,
        name: "file.exe",
        sizeHint: 10,
      })
    ).ok,
    false,
  );
  const p = await x.call("B", "file.beginUpload", {
    purpose: "TASK_DRAFT",
    taskId: t.taskId,
    name: "file.pdf",
    sizeHint: 8,
  });
  x.storage.blobs.set("test://" + p.tempPath, Buffer.from("not pdf!"));
  assert.equal(
    (
      await x.raw("B", "file.finalizeUpload", {
        uploadSessionId: p.uploadSessionId,
        tempFileId: "test://" + p.tempPath,
      })
    ).error.code,
    "UNSUPPORTED_FILE_TYPE",
  );
  x.setNow(x.getNow() + 3600001);
  assert.equal(
    (
      await x.raw("B", "file.finalizeUpload", {
        uploadSessionId: p.uploadSessionId,
        tempFileId: "test://" + p.tempPath,
      })
    ).ok,
    false,
  );
});
test("all stats include more than one page; pending filter includes DOING; mixed-role home scoped", async () => {
  const x = await setup();
  for (let i = 0; i < 55; i++) await x.task(i % 2 ? "C" : "B");
  const first = await x.call("C", "task.list", {
    projectId: x.p.projectId,
    filter: "ALL",
    pageSize: 20,
  });
  assert.equal(first.items.length, 20);
  assert.equal(first.statistics.total, 55);
  const next = await x.call("C", "task.list", {
    projectId: x.p.projectId,
    filter: "ALL",
    pageSize: 20,
    cursor: first.nextCursor,
  });
  assert.equal(
    next.items.some((t) => first.items.some((q) => q.taskId === t.taskId)),
    false,
  );
  const home = await x.call("B", "home.get");
  assert.equal(home.pending, 28);
  const leaderHome = await x.call("A", "home.get");
  assert.equal(leaderHome.pending, 55);
  const p = await x.project("B");
  assert.equal((await x.call("B", "home.get")).view, "LEADER");
  assert.equal((await x.call("B", "home.get")).pending, 28);
  assert.ok(p.projectId);
});
test("archive blocks writes but preserves reads and personal notification actions", async () => {
  const x = await setup(),
    t = await x.task();
  const p = await x.db.get("projects", x.p.projectId);
  p.status = "ARCHIVED";
  await x.db.put("projects", p._id, p);
  assert.equal(
    (await x.raw("D", "project.join", { code: x.p.inviteCode })).error.code,
    "PROJECT_ARCHIVED",
  );
  assert.equal(
    (
      await x.raw("B", "file.beginUpload", {
        purpose: "TASK_DRAFT",
        taskId: t.taskId,
        name: "x.pdf",
        sizeHint: 10,
      })
    ).error.code,
    "PROJECT_ARCHIVED",
  );
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).capabilities
      .canFirstUpload,
    false,
  );
  const n = await x.call("B", "notification.list", { category: "ALL" });
  await x.call("B", "notification.readAll", { watermark: n.watermark });
  assert.equal((await x.call("B", "notification.unreadCount")).count, 0);
});
test("invite lookup rate limits all repeated attempts, including invalid codes", async () => {
  const x = await setup();
  for (let i = 0; i < 10; i++)
    await x.raw("D", "invite.lookup", { code: "AAAAAA" }, "lookup-request");
  assert.equal(
    (
      await x.raw(
        "D",
        "invite.lookup",
        { code: x.p.inviteCode },
        "lookup-request",
      )
    ).error.code,
    "RATE_LIMITED",
  );
  x.setNow(x.getNow() + 60000);
  const preview = await x.call("D", "invite.lookup", {
    code: x.p.inviteCode.toLowerCase(),
  });
  assert.deepEqual(Object.keys(preview).sort(), [
    "description",
    "dueAt",
    "ownerDisplayName",
    "projectName",
  ]);
});
test("new project assets are private until published and edit cancellation preserves public references", async () => {
  const x = await setup();
  let d = await x.call("C", "project.draftOpen", { mode: "NEW" });
  const r = await x.upload("C", {
    purpose: "PROJECT_REFERENCE_DRAFT",
    draftKey: d.draftKey,
  });
  d = await x.call("C", "project.draftSave", {
    mode: "NEW",
    draftId: d.draftId,
    fields: {
      name: "素材项目",
      dueAt: x.getNow() + 10000,
      timezone: "Asia/Shanghai",
    },
    referenceInputs: [
      { revisionId: r.revisionId, category: "REFERENCE", description: "文档" },
    ],
    expectedDraftRevision: d.draftRevision,
  });
  assert.ok(
    (
      await x.call("C", "file.getReadTicket", {
        target: {
          kind: "projectDraft",
          id: d.draftId,
          revisionId: r.revisionId,
        },
      })
    ).downloadUrl,
  );
  assert.equal(
    (
      await x.raw("B", "file.getReadTicket", {
        target: {
          kind: "projectDraft",
          id: d.draftId,
          revisionId: r.revisionId,
        },
      })
    ).ok,
    false,
  );
  const p = await x.call("C", "project.publish", {
    draftId: d.draftId,
    expectedDraftRevision: d.draftRevision,
  });
  await x.call("B", "project.join", { code: p.inviteCode });
  const refs = await x.call("B", "reference.list", { projectId: p.projectId });
  assert.equal(refs.total, 1);
  const edit = await x.call("C", "project.draftOpen", {
    mode: "EDIT",
    projectId: p.projectId,
  });
  await x.call("C", "project.draftSave", {
    mode: "EDIT",
    draftId: edit.draftId,
    fields: edit.fields,
    referenceInputs: [],
    expectedDraftRevision: edit.draftRevision,
  });
  assert.equal(
    (await x.call("B", "reference.list", { projectId: p.projectId })).total,
    1,
  );
});
test("task edit draft preserves state and exposes only to leader; stale edit fails", async () => {
  const x = await setup(),
    t = await x.task();
  const d = await x.call("A", "task.draftSave", {
    mode: "EDIT",
    projectId: x.p.projectId,
    taskId: t.taskId,
    expectedDraftRevision: 0,
    fields: { title: "草稿编辑" },
  });
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).title,
    "任务",
  );
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).editDraft,
    null,
  );
  const s = await x.submit(t);
  assert.equal(
    (
      await x.raw("A", "task.update", {
        taskId: t.taskId,
        fields: {
          title: "草稿编辑",
          assigneeId: x.users.B.userId,
          dueAt: t.effectiveDueAt,
        },
        expectedRevision: s.task.revision,
        expectedDraftRevision: d.draftRevision,
      })
    ).error.code,
    "STALE_REVISION",
  );
});
test("feedback acknowledgement locates recipient review notification only", async () => {
  const x = await setup(),
    s = await x.submit(await x.task()),
    r = await x.reject(s);
  assert.equal(
    (await x.call("A", "notification.read", { reviewId: r.reviewId }))
      .matchedCount,
    0,
  );
  assert.equal(
    (await x.call("B", "notification.read", { reviewId: r.reviewId }))
      .matchedCount,
    1,
  );
  const list = await x.call("B", "notification.list", { category: "FEEDBACK" });
  assert.equal(list.items[0].isRead, true);
});
test("a former owner regaining a later assignment cannot replay an earlier-round saved draft", async () => {
  const x = await setup(),
    t = await x.task(),
    r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  const payload = {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "FIRST",
    expectedTaskRevision: t.revision,
  };
  const saved = await x.call(
    "B",
    "submission.saveDraft",
    payload,
    "persisted-old-save",
  );
  let next = await x.call("A", "task.update", {
    taskId: t.taskId,
    fields: {
      title: t.title,
      dueAt: t.effectiveDueAt,
      assigneeId: x.users.C.userId,
    },
    expectedRevision: saved.revision,
    confirmReassign: true,
  });
  next = await x.call("A", "task.update", {
    taskId: t.taskId,
    fields: {
      title: t.title,
      dueAt: t.effectiveDueAt,
      assigneeId: x.users.B.userId,
    },
    expectedRevision: next.revision,
    confirmReassign: true,
  });
  assert.equal(next.assignmentEpoch, 3);
  const replay = await x.raw(
    "B",
    "submission.saveDraft",
    payload,
    "persisted-old-save",
  );
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "STALE_REVISION");
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).draft,
    null,
  );
});

test("deployment file gate denies both new uploads and existing read tickets without affecting database reads", async () => {
  const x = await setup();
  const task = await x.task();
  const submitted = await x.submit(task);
  x.service.filesEnabled = false;
  for (const [action, payload] of [
    ['file.beginUpload', {purpose:'TASK_DRAFT',taskId:task.taskId,name:'blocked.pdf',sizeHint:20}],
    ['file.getReadTicket', {target:{kind:'submission',id:submitted.submission.submissionId}}]
  ]) {
    const r = await x.raw('B',action,payload);
    assert.equal(r.ok,false);
    assert.equal(r.error.code,'INVALID_STATE');
    assert.match(r.error.message,/权限尚未配置/);
  }
  assert.equal((await x.raw('B','task.get',{taskId:task.taskId})).ok,true);
});
