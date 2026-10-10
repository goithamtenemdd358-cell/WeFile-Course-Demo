const test = require("node:test"),
  assert = require("node:assert/strict");
const { setup } = require("./support");
const nav = require("../miniprogram/services/navigation");
const create = require("../miniprogram/services/page");
async function harness() {
  const x = await setup();
  let who = "A";
  const app = {
      globalData: { cloudEnv: "test-adapter-only", user: x.users.A, unread: 0 },
    },
    store = {},
    events = [];
  global.getApp = () => app;
  global.getCurrentPages = () => [];
  global.wx = {
    cloud: {
      callFunction: async ({ data }) => ({
        result: await x.service.invoke(who, data),
      }),
    },
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => (store[k] = v),
    removeStorageSync: (k) => delete store[k],
    showModal: async () => ({ confirm: true }),
    showToast: (v) => events.push(v),
    login: async () => ({ code: "test-only" }),
    navigateTo: (v) => events.push(v),
    redirectTo: (v) => events.push(v),
    reLaunch: (v) => events.push(v),
    navigateBack: (v) => events.push(v),
    stopPullDownRefresh() {},
  };
  function page(id, args = {}) {
    const def = create(id),
      p = { ...def, data: structuredClone(def.data) };
    p.setData = function (values) {
      for (const [key, v] of Object.entries(values)) {
        const keys = key.split(".");
        let at = this.data;
        while (keys.length > 1) {
          const k = keys.shift();
          at[k] = at[k] || {};
          at = at[k];
        }
        at[keys[0]] = v;
      }
    };
    const frame = nav.frame(id, args);
    p.onLoad({ navToken: frame.token });
    return p;
  }
  return {
    ...x,
    page,
    app,
    events,
    store,
    as(v) {
      who = v;
      app.globalData.user = x.users[v];
    },
  };
}
test("page 05 real controller saves decorated edit fields without schema pollution", async () => {
  const x = await harness(),
    p = x.page("05", { projectId: x.p.projectId });
  await p.onShow();
  assert.equal(p.data.error, "");
  p.input({
    currentTarget: { dataset: { field: "name", form: true } },
    detail: { value: "页面编辑" },
  });
  await p.perform("publishProject", {});
  assert.equal(
    (await x.call("B", "project.get", { projectId: x.p.projectId })).fields
      .name,
    "页面编辑",
  );
  assert.equal(p.dirty, false);
});
test("task edit saves initial draft with revision zero and remains unpublished until save", async () => {
  const x = await harness(),
    t = await x.task(),
    p = x.page("14", { projectId: x.p.projectId, taskId: t.taskId });
  await p.onShow();
  p.input({
    currentTarget: { dataset: { field: "title", form: true } },
    detail: { value: "任务草稿编辑" },
  });
  await p.perform("saveTaskDraft", {});
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).title,
    "任务",
  );
  const again = x.page("14", { projectId: x.p.projectId, taskId: t.taskId });
  await again.onShow();
  assert.equal(again.data.form.title, "任务草稿编辑");
  await again.perform("publishTask", {});
  assert.equal(
    (await x.call("B", "task.get", { taskId: t.taskId })).title,
    "任务草稿编辑",
  );
});
test("task-detail controller submits saved OVERWRITE draft using stored baseline", async () => {
  const x = await harness(),
    t = await x.task(),
    s = await x.submit(t),
    rejected = await x.reject(s);
  const r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  await x.call("B", "submission.saveDraft", {
    taskId: t.taskId,
    revisionId: r.revisionId,
    mode: "OVERWRITE",
    baseVersionId: s.visibleVersion.visibleVersionId,
    expectedVersionRevision: 1,
    expectedTaskRevision: rejected.task.revision,
  });
  x.as("B");
  const p = x.page("12", { taskId: t.taskId });
  await p.onShow();
  await p.perform("submit", {});
  assert.equal(p.data.task.state, "SUBMITTED");
  assert.equal(p.data.task.currentSubmission.displayNumber, 1);
});
test("all 22 page controllers load authorized paths using real service contract", async () => {
  const x = await harness(),
    t = await x.task(),
    s = await x.submit(t);
  const idsA = [
    "02",
    "03",
    "03-A",
    "04",
    "05",
    "06",
    "07",
    "08",
    "09",
    "10",
    "11",
    "12",
    "14",
    "15",
    "16",
    "17",
    "18",
    "02-A",
  ];
  for (const id of idsA) {
    const p = x.page(id, {
      projectId: x.p.projectId,
      taskId: t.taskId,
      submissionId: s.submission.submissionId,
    });
    await p.onShow();
    assert.equal(p.data.error, "", id + ": " + p.data.error);
  }
  const rejected = await x.reject(s);
  x.as("B");
  for (const id of ["19", "20"]) {
    const p = x.page(id, {
      projectId: x.p.projectId,
      taskId: t.taskId,
      reviewId: rejected.reviewId,
    });
    await p.onShow();
    assert.equal(p.data.error, "", id + ": " + p.data.error);
  }
  const fresh = await x.task();
  const upload = x.page("13", { taskId: fresh.taskId });
  await upload.onShow();
  assert.equal(upload.data.error, "");
  x.store.explicitLogout = true;
  x.app.globalData.user = null;
  const login = x.page("01");
  await login.onShow();
  assert.equal(login.data.error, "");
});
test("logout persists until explicit login and clears cached user", async () => {
  const x = await harness(),
    p = x.page("02-A");
  await p.onShow();
  await p.perform("logout", {});
  assert.equal(x.app.globalData.user, null);
  assert.equal(x.store.explicitLogout, true);
  const login = x.page("01");
  await login.onShow();
  assert.equal(x.app.globalData.user, null);
  await login.perform("login", {});
  assert.equal(x.app.globalData.user.userId, x.users.A.userId);
  assert.equal(x.store.explicitLogout, undefined);
});
test("failed upload stays on page and uses required failure toast; hiding clears delayed success", async () => {
  const x = await harness(),
    t = await x.task();
  x.as("B");
  const p = x.page("13", { taskId: t.taskId });
  await p.onShow();
  await p.action({ currentTarget: { dataset: { action: "submit" } } });
  assert.match(p.data.error, /选择/);
  assert.equal(x.events.at(-1).title, "提交失败，请检查网络或文件大小");
  assert.equal(
    x.events.some((e) => e.url),
    false,
  );
  const r = await x.upload("B", { purpose: "TASK_DRAFT", taskId: t.taskId });
  p.uploaded = r;
  await p.perform("submit", {});
  assert.equal(x.events.at(-1).title, "提交成功，等待组长审核");
  assert.equal(x.events.at(-1).duration, 2500);
  p.onHide();
  assert.equal(p.visible, false);
});

test("project info displays references that were published to the project", async () => {
  const x = await harness();
  const upload = await x.upload("A", {
    purpose: "PROJECT_REFERENCE",
    projectId: x.p.projectId,
  });
  await x.call("A", "reference.create", {
    projectId: x.p.projectId,
    revisionId: upload.revisionId,
    category: "REFERENCE",
    description: "课程资料",
  });
  const p = x.page("08", { projectId: x.p.projectId });
  await p.onShow();
  assert.equal(p.data.error, "");
  assert.equal(p.data.references.length, 1);
  assert.equal(p.data.references[0].description, "课程资料");
});

test("leader can assign a task to self and upload its draft", async () => {
  const x = await harness();
  const p = x.page("14", { projectId: x.p.projectId });
  await p.onShow();
  assert.ok(p.data.members.some((m) => m.userId === x.users.A.userId));
  const task = await x.task("A");
  const uploaded = await x.upload("A", {
    purpose: "TASK_DRAFT",
    projectId: x.p.projectId,
    taskId: task.taskId,
  });
  assert.ok(uploaded.revisionId);
});

test("optional form fields receive safe demo defaults", async () => {
  const x = await harness();
  const newUser = await x.call("E", "auth.bootstrap");
  const profile = await x.call("E", "user.update", {
    expectedRevision: newUser.user.revision,
  });
  assert.equal(profile.displayName, "微信用户");
  let draft = await x.call("A", "project.draftOpen", { mode: "NEW" });
  draft = await x.call("A", "project.draftSave", {
    mode: "NEW",
    draftId: draft.draftId,
    fields: {},
    referenceInputs: [],
    expectedDraftRevision: draft.draftRevision,
  });
  const project = await x.call("A", "project.publish", {
    draftId: draft.draftId,
    expectedDraftRevision: draft.draftRevision,
  });
  const projectDetail = await x.call("A", "project.get", { projectId: project.projectId });
  assert.equal(projectDetail.fields.name, "未命名项目");
  assert.ok(projectDetail.fields.dueAt > x.getNow());
  const task = await x.call("A", "task.publish", {
    projectId: project.projectId,
    fields: {},
  });
  const taskDetail = await x.call("A", "task.get", { taskId: task.taskId });
  assert.equal(taskDetail.title, "未命名任务");
  assert.equal(taskDetail.assigneeId, x.users.A.userId);
});

test("empty revision feedback receives a default message", async () => {
  const x = await harness();
  const task = await x.task();
  const submission = await x.submit(task);
  const rejected = await x.call("A", "review.reject", {
    submissionId: submission.submission.submissionId,
    expectedTaskRevision: submission.task.revision,
    reason: "",
    revisionDueAt: null,
    priority: "NORMAL",
  });
  const feedback = await x.call("B", "review.get", { reviewId: rejected.reviewId });
  assert.equal(feedback.reason, "请按要求修改");
});
test("standalone reference selection does not leave a false unsaved-change warning", async () => {
  const x = await harness(),
    p = x.page("09", { projectId: x.p.projectId });
  await p.onShow();
  wx.chooseMessageFile = async () => ({
    tempFiles: [{ path: "/tmp/course.docx", name: "course.docx", size: 1 }],
  });
  p.pick({
    currentTarget: { dataset: { field: "categoryIndex" } },
    detail: { value: "2" },
  });
  p.input({
    currentTarget: { dataset: { field: "referenceDescription" } },
    detail: { value: "课堂材料" },
  });
  await p.perform("chooseReference", {});
  assert.equal(p.data.referenceName, "course.docx");
  assert.equal(!!p.dirty, false);
});
test("cloud function timeout gets an actionable course-trial message", async () => {
  const x = await harness(), api = require("../miniprogram/services/api");
  const original = wx.cloud.callFunction;
  wx.cloud.callFunction = async () => {
    const error = new Error("Invoking task timed out after 60 seconds");
    error.errCode = -504003;
    throw error;
  };
  await assert.rejects(
    () => api.call("reference.list", { projectId: x.p.projectId }),
    /服务连接超时。请让项目组织者确认电脑没有休眠/,
  );
  wx.cloud.callFunction = original;
});