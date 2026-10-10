"use strict";
const { id, fresh, check, cas } = require("./core");
async function prepare(c, p) {
  const { t, p: project } = await c.task(p.taskId, {
    owner: true,
    write: true,
  });
  cas(t.revision, p.expectedTaskRevision);
  const first = ["TODO", "DOING"].includes(t.state);
  check(first || t.state === "CHANGES_REQUESTED", "INVALID_STATE");
  check(
    first
      ? p.mode === "FIRST" && !t.latestSubmissionId
      : ["KEEP", "OVERWRITE"].includes(p.mode),
    "INVALID_STATE",
  );
  const r = await c.get("file_revisions", p.revisionId);
  check(
    r.purpose === "TASK_DRAFT" &&
      r.taskId === t._id &&
      r.assignmentEpoch === t.assignmentEpoch &&
      r.createdBy === c.actor &&
      r.lifecycle === "SEALED" &&
      !r.submissionId,
  );
  let base = null;
  if (!first) {
    check(p.baseVersionId === t.currentVersionId, "VERSION_CONFLICT");
    base = await c.get("file_versions", p.baseVersionId);
    cas(base.revision, p.expectedVersionRevision);
  }
  return { t, r, base, project };
}
module.exports = {
  async "submission.saveDraft"(c, p) {
    const { t, r } = await prepare(c, p);
    r.attached = true;
    await c.db.put("file_revisions", r._id, r);
    t.draft = {
      revisionId: p.revisionId,
      mode: p.mode,
      note: p.note || "",
      baseVersionId: p.baseVersionId || null,
      baseVersionRevision: p.expectedVersionRevision ?? null,
      assignmentEpoch: t.assignmentEpoch,
      savedBy: c.actor,
      savedAt: c.now,
      draftRevision: (t.draft ? t.draft.draftRevision : 0) + 1,
    };
    if (p.mode === "FIRST") t.state = "DOING";
    t.revision++;
    await c.db.put("tasks", t._id, t);
    return { taskId: t._id };
  },
  async "submission.submit"(c, p) {
    const { t, r, base, project } = await prepare(c, p);
    const k = fresh();
    let v;
    if (p.mode === "OVERWRITE") {
      v = base;
      const old = await c.get("file_revisions", v.currentRevisionId);
      old.lifecycle = "AUDIT_ONLY";
      await c.db.put("file_revisions", old._id, old);
      await c.audit("OVERWRITE", k, {
        projectId: t.projectId,
        taskId: t._id,
        beforeRefs: [old._id],
        afterRefs: [r._id],
      });
      v.currentRevisionId = r._id;
      v.revision++;
    } else {
      t.versionCounter++;
      const vk = id("version", t._id, t.assignmentEpoch, t.versionCounter);
      v = {
        _id: vk,
        projectId: t.projectId,
        taskId: t._id,
        assignmentEpoch: t.assignmentEpoch,
        fileId: id(t._id, t.assignmentEpoch),
        displayNumber: t.versionCounter,
        currentRevisionId: r._id,
        revision: 1,
      };
    }
    v.submittedBy = c.actor;
    v.submittedAt = c.now;
    const s = {
      _id: k,
      submissionId: k,
      projectId: t.projectId,
      taskId: t._id,
      assignmentEpoch: t.assignmentEpoch,
      submittedBy: c.actor,
      visibleVersionId: v._id,
      revisionId: r._id,
      displayNumber: v.displayNumber,
      taskRequirementsSnapshot: {
        title: t.title,
        description: t.description,
        requirements: t.requirements,
        projectUnifiedRequirements: project.fields.unifiedRequirements || "",
      },
      note: p.note || "",
      submittedAt: c.now,
      dueAtSnapshot: t.dueAt,
      submittedLate: c.now > t.dueAt,
      decision: "PENDING",
      reviewId: null,
    };
    r.attached = true;
    r.submissionId = k;
    r.lifecycle = "VISIBLE";
    t.state = "SUBMITTED";
    t.latestSubmissionId = k;
    t.currentVersionId = v._id;
    t.submittedLate = s.submittedLate;
    t.draft = null;
    t.revision++;
    await c.db.put("file_revisions", r._id, r);
    await c.db.put("file_versions", v._id, v);
    await c.db.put("files", v.fileId, {
      _id: v.fileId,
      projectId: t.projectId,
      taskId: t._id,
      assignmentEpoch: t.assignmentEpoch,
      scope: "TASK",
      currentVersionId: v._id,
      versionCounter: t.versionCounter,
    });
    await c.db.put("submissions", k, s);
    await c.db.put("tasks", t._id, t);
    await c.notify(
      t,
      p.mode === "FIRST" ? "FIRST_SUBMITTED" : "RESUBMITTED",
      project.ownerId,
      k,
      { submissionId: k },
    );
    return { taskId: t._id, submissionId: k, visibleVersionId: v._id };
  },
  async "review.approve"(c, p) {
    return review(c, p, false);
  },
  async "review.reject"(c, p) {
    return review(c, p, true);
  },
};
async function review(c, p, reject) {
  const s = await c.get("submissions", p.submissionId);
  const { t } = await c.task(s.taskId, { leader: true, write: true });
  cas(t.revision, p.expectedTaskRevision);
  check(
    t.state === "SUBMITTED" &&
      t.latestSubmissionId === s._id &&
      s.assignmentEpoch === t.assignmentEpoch &&
      s.decision === "PENDING",
    "STALE_REVISION",
    "该提交已处理或已被替换",
  );
  const reason = (p.reason || "").trim() || "请按要求修改";
  const k = id("review", s._id);
  const r = {
    _id: k,
    projectId: t.projectId,
    taskId: t._id,
    assignmentEpoch: t.assignmentEpoch,
    submissionId: s._id,
    visibleVersionId: s.visibleVersionId,
    revisionId: s.revisionId,
    decision: reject ? "REJECTED" : "APPROVED",
    reason: reject ? reason : "",
    priority: p.priority || "NORMAL",
    newDueAt: reject ? p.revisionDueAt : null,
    previousDueAt: t.dueAt,
    reviewedBy: c.actor,
    reviewedAt: c.now,
  };
  s.decision = r.decision;
  s.reviewId = k;
  t.state = reject ? "CHANGES_REQUESTED" : "DONE";
  if (reject) {
    t.latestReviewId = k;
    if (p.revisionDueAt !== null && p.revisionDueAt !== t.dueAt) {
      t.dueAt = p.revisionDueAt;
      t.dueRevision++;
    }
  } else t.approvedSubmissionId = s._id;
  t.revision++;
  await c.db.put("reviews", k, r);
  await c.db.put("submissions", s._id, s);
  await c.db.put("tasks", t._id, t);
  await c.notify(
    t,
    reject ? "CHANGES_REQUESTED" : "APPROVED",
    t.assigneeId,
    k,
    { reviewId: k, submissionId: s._id },
  );
  return { taskId: t._id, reviewId: k };
}
