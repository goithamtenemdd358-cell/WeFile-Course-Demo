"use strict";
const { Service } = require("../cloudfunctions/api/_shared/service");
const { hash } = require("../cloudfunctions/api/_shared/core");
const assert = require("node:assert/strict");
// Test-only transactional adapter. Never deployed or imported by the mini program.
class MemoryDB {
  constructor() {
    this.rows = new Map();
    this.queue = Promise.resolve();
    this.failCollection = null;
  }
  key(c, k) {
    return c + ":" + k;
  }
  async get(c, k) {
    return structuredClone(this.rows.get(this.key(c, k)) || null);
  }
  async put(c, k, v) {
    if (c === this.failCollection) throw new Error("injected database failure");
    this.rows.set(this.key(c, k), structuredClone(v));
  }
  async query(c, where) {
    return [...this.rows.entries()]
      .filter(
        ([k, v]) =>
          k.startsWith(c + ":") &&
          Object.entries(where).every(([field, value]) => v[field] === value),
      )
      .map(([, v]) => structuredClone(v));
  }
  async transaction(fn) {
    const work = this.queue.then(async () => {
      const snapshot = structuredClone(this.rows);
      try {
        return await fn({
          get: this.get.bind(this),
          put: this.put.bind(this),
          query: () => {
            throw new Error("query inside transaction");
          },
        });
      } catch (e) {
        this.rows = snapshot;
        throw e;
      }
    });
    this.queue = work.catch(() => {});
    return work;
  }
}
class MemoryStorage {
  constructor() {
    this.blobs = new Map();
    this.failSeal = false;
    this.sealed = [];
  }
  async readTemporary(fileId, path, max) {
    assert.equal(fileId, "test://" + path);
    const b = this.blobs.get(fileId);
    assert.ok(b);
    assert.ok(b.length <= max);
    return Buffer.from(b);
  }
  async seal(path, bytes) {
    if (this.failSeal) throw new Error("injected storage failure");
    const key = "test://" + path;
    assert.ok(!this.blobs.has(key));
    this.blobs.set(key, Buffer.from(bytes));
    this.sealed.push(key);
    return key;
  }
  async ticket(blob) {
    assert.ok(this.blobs.has(blob));
    return {
      url: "https://example.invalid/" + encodeURIComponent(blob),
      expiresAt: 2000000000000,
    };
  }
}
async function setup() {
  const db = new MemoryDB(),
    storage = new MemoryStorage();
  let now = 1800000000000,
    counter = 0;
  const service = new Service(db, storage, {
    secret: "test-secret-32-characters-long-only",
    now: () => now,
  });
  const raw = (who, action, payload = {}, requestId) =>
    service.invoke(who, {
      action,
      payload,
      requestId: requestId || `request-${++counter}`,
    });
  const call = async (...args) => {
    const r = await raw(...args);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.data;
  };
  const users = {};
  for (const who of ["A", "B", "C", "D"]) {
    const r = await call(who, "auth.bootstrap");
    users[who] = await call(who, "user.update", {
      displayName: who,
      expectedRevision: r.user.revision,
    });
  }
  async function project(who = "A") {
    let d = await call(who, "project.draftOpen", { mode: "NEW" });
    d = await call(who, "project.draftSave", {
      mode: "NEW",
      draftId: d.draftId,
      fields: {
        name: "测试项目",
        description: "说明",
        dueAt: now + 86400000,
        timezone: "Asia/Shanghai",
      },
      referenceInputs: [],
      expectedDraftRevision: d.draftRevision,
    });
    return call(who, "project.publish", {
      draftId: d.draftId,
      expectedDraftRevision: d.draftRevision,
    });
  }
  const p = await project();
  for (const who of ["B", "C"])
    await call(who, "project.join", { code: p.inviteCode });
  const task = (who = "B", extra = {}) =>
    call("A", "task.publish", {
      projectId: p.projectId,
      fields: {
        title: "任务",
        description: "私有说明",
        requirements: "私有要求",
        assigneeId: users[who].userId,
        dueAt: now + 3600000,
        ...extra,
      },
    });
  async function upload(
    who,
    scope,
    bytes = Buffer.from("%PDF-1.7\nTest original bytes\n%%EOF"),
  ) {
    const plan = await call(who, "file.beginUpload", {
      ...scope,
      name: "交付.pdf",
      sizeHint: bytes.length,
    });
    const fileId = "test://" + plan.tempPath;
    storage.blobs.set(fileId, bytes);
    return call(who, "file.finalizeUpload", {
      uploadSessionId: plan.uploadSessionId,
      tempFileId: fileId,
    });
  }
  async function submit(t, mode = "FIRST", who = "B") {
    const r = await upload(who, {
      purpose: "TASK_DRAFT",
      projectId: p.projectId,
      taskId: t.taskId,
    });
    const base =
      mode === "FIRST"
        ? {}
        : {
            baseVersionId: t.currentSubmission.visibleVersionId,
            expectedVersionRevision: (
              await call(who, "version.list", { taskId: t.taskId })
            ).items.find(
              (v) =>
                v.visibleVersionId === t.currentSubmission.visibleVersionId,
            ).versionRevision,
          };
    return call(who, "submission.submit", {
      taskId: t.taskId,
      revisionId: r.revisionId,
      mode,
      expectedTaskRevision: t.revision,
      ...base,
    });
  }
  const reject = (s) =>
    call("A", "review.reject", {
      submissionId: s.submission.submissionId,
      expectedTaskRevision: s.task.revision,
      reason: "补充数据",
      revisionDueAt: null,
      priority: "IMPORTANT",
    });
  return {
    db,
    storage,
    service,
    raw,
    call,
    users,
    p,
    project,
    task,
    upload,
    submit,
    reject,
    setNow: (n) => (now = n),
    getNow: () => now,
    hash,
  };
}
module.exports = { setup, MemoryDB, MemoryStorage };
