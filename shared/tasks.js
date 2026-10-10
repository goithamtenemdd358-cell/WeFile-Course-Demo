"use strict";
const { id, fresh, check, cas, pending } = require("./core");
const dto = require("./projections");
async function completedFields(c, projectId, fields, existing = null) {
  const project = await c.get("projects", projectId);
  return {
    ...fields,
    title: (fields.title || (existing && existing.title) || "未命名任务").trim() || "未命名任务",
    description: fields.description || "",
    requirements: fields.requirements || "",
    assigneeId: fields.assigneeId || (existing && existing.assigneeId) || c.actor,
    dueAt: Number.isInteger(fields.dueAt) ? fields.dueAt : (existing && existing.dueAt) || project.fields.dueAt || c.now + 7 * 86400000,
  };
}
async function assignee(c, projectId, fields) {
  const m = await c.db.get("project_members", id(projectId, fields.assigneeId));
  check(
    m && m.active && (m.role === "MEMBER" || fields.assigneeId === c.actor),
    "INVALID_INPUT",
    "负责人必须是已加入成员；组长只能给自己分配",
  );
}
async function voidPending(c, t) {
  if (t.latestSubmissionId) {
    const s = await c.get("submissions", t.latestSubmissionId);
    if (s.decision === "PENDING") {
      s.decision = "VOIDED";
      await c.db.put("submissions", s._id, s);
    }
  }
}
module.exports = {
  async "task.draftSave"(c, p) {
    await c.member(p.projectId, true, true);
    if (p.mode === "EDIT") {
      const { t } = await c.task(p.taskId, { leader: true, write: true });
      check(t.projectId === p.projectId);
      const old = t.editDraft;
      cas(old ? old.draftRevision : 0, p.expectedDraftRevision);
      t.editDraft = {
        _id: t._id,
        mode: "EDIT",
        taskId: t._id,
        projectId: t.projectId,
        fields: p.fields,
        baseTaskRevision: old ? old.baseTaskRevision : t.revision,
        draftRevision: old ? old.draftRevision + 1 : 1,
      };
      await c.db.put("tasks", t._id, t);
      return dto.taskDraft(t.editDraft);
    }
    const k = p.draftTaskId || fresh();
    const old = await c.db.get("tasks", k);
    if (old) {
      check(old.projectId === p.projectId && old.publication === "DRAFT");
      cas(old.draftRevision, p.expectedDraftRevision);
    }
    const d = {
      _id: k,
      projectId: p.projectId,
      publication: "DRAFT",
      fields: p.fields,
      draftRevision: old ? old.draftRevision + 1 : 1,
      deletedAt: null,
    };
    await c.db.put("tasks", k, d);
    return dto.taskDraft(d);
  },
  async "task.publish"(c, p) {
    await c.member(p.projectId, true, true);
    const fields = await completedFields(c, p.projectId, p.fields);
    await assignee(c, p.projectId, fields);
    const k = p.draftTaskId || fresh();
    if (p.draftTaskId) {
      const d = await c.get("tasks", k);
      check(d.projectId === p.projectId && d.publication === "DRAFT");
      cas(d.draftRevision, p.expectedDraftRevision);
    }
    const t = {
      _id: k,
      projectId: p.projectId,
      ...fields,
      publication: "PUBLISHED",
      assignmentEpoch: 1,
      dueRevision: 1,
      state: "TODO",
      revision: 1,
      deletedAt: null,
      draft: null,
      latestSubmissionId: null,
      latestReviewId: null,
      versionCounter: 0,
      currentVersionId: null,
      createdAt: c.now,
    };
    await c.db.put("tasks", k, t);
    await c.notify(t, "TASK_ASSIGNED", t.assigneeId, k);
    return { taskId: k };
  },
  async "task.update"(c, p) {
    const { t } = await c.task(p.taskId, { leader: true, write: true });
    cas(t.revision, p.expectedRevision);
    p.fields = await completedFields(c, t.projectId, p.fields, t);
    await assignee(c, t.projectId, p.fields);
    if (p.expectedDraftRevision !== undefined) {
      check(t.editDraft, "STALE_REVISION");
      cas(t.editDraft.draftRevision, p.expectedDraftRevision);
      cas(t.editDraft.baseTaskRevision, t.revision);
    }
    if (t.assigneeId !== p.fields.assigneeId) {
      check(
        p.confirmReassign === true,
        "INVALID_INPUT",
        "更换负责人须确认开启新分配轮次",
      );
      await voidPending(c, t);
      await c.notify(
        t,
        "ASSIGNMENT_CHANGED",
        t.assigneeId,
        id(t._id, t.revision),
      );
      t.assignmentEpoch++;
      t.state = "TODO";
      t.draft = null;
      t.latestSubmissionId = null;
      t.approvedSubmissionId = null;
      t.latestReviewId = null;
      t.currentVersionId = null;
      t.versionCounter = 0;
      t.submittedLate = false;
      await c.notify(
        { ...t, title: p.fields.title },
        "TASK_ASSIGNED",
        p.fields.assigneeId,
        id(t._id, t.assignmentEpoch),
      );
    }
    if (t.dueAt !== p.fields.dueAt) t.dueRevision++;
    Object.assign(t, p.fields, { revision: t.revision + 1, editDraft: null });
    await c.db.put("tasks", t._id, t);
    return { taskId: t._id };
  },
  async "task.delete"(c, p) {
    const { t } = await c.task(p.taskId, { leader: true, write: true });
    cas(t.revision, p.expectedRevision);
    await voidPending(c, t);
    t.deletedAt = c.now;
    t.revision++;
    await c.db.put("tasks", t._id, t);
    return { deleted: true };
  },
  async "task.remind"(c, p) {
    const { t } = await c.task(p.taskId, { leader: true, write: true });
    if (p.expectedRevision !== undefined) cas(t.revision, p.expectedRevision);
    check(pending(t), "INVALID_STATE");
    const k = id("manual", t._id, t.assignmentEpoch);
    const old = await c.db.get("operations", k);
    check(!old || c.now - old.at >= 1800000, "RATE_LIMITED", "30分钟内已提醒");
    await c.db.put("operations", k, { _id: k, at: c.now });
    return c.notify(t, "MANUAL_REMINDER", t.assigneeId, id(t._id, c.now));
  },
};
