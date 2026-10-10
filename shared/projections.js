"use strict";
const { check, overdue, pending, stats } = require("./core");
const pick = (o, ks) => Object.fromEntries(ks.map((k) => [k, o[k]]));
const user = (u) => ({
  userId: u._id,
  displayName: u.displayName,
  avatarReadRef: u.avatarRevisionId || null,
  profileComplete: u.profileComplete,
  revision: u.revision,
});
const draft = (d) => ({
  draftId: d._id,
  draftKey: d._id,
  mode: d.mode,
  projectId: d.projectId || null,
  saved: d.saved,
  fields: d.fields,
  coverRevisionId: d.coverRevisionId || null,
  referenceInputs: d.referenceInputs,
  draftRevision: d.draftRevision,
  baseProjectRevision: d.baseProjectRevision ?? null,
});
const taskDraft = (t) => ({
  mode: t.mode || "NEW",
  draftTaskId: t._id,
  taskId: t.taskId || null,
  projectId: t.projectId,
  fields: t.fields,
  draftRevision: t.draftRevision,
  baseTaskRevision: t.baseTaskRevision ?? null,
});
async function name(c, k) {
  return (await c.get("users", k)).displayName;
}
async function submission(c, s) {
  const r = await c.get("file_revisions", s.revisionId);
  return {
    ...pick(s, [
      "submissionId",
      "projectId",
      "taskId",
      "assignmentEpoch",
      "submittedBy",
      "visibleVersionId",
      "revisionId",
      "displayNumber",
      "taskRequirementsSnapshot",
      "note",
      "submittedAt",
      "dueAtSnapshot",
      "submittedLate",
      "decision",
      "reviewId",
    ]),
    fileAvailability: r.lifecycle === "AUDIT_ONLY" ? "AUDIT_ONLY" : "VISIBLE",
  };
}
async function version(c, v) {
  const r = await c.get("file_revisions", v.currentRevisionId);
  return {
    visibleVersionId: v._id,
    displayNumber: v.displayNumber,
    revisionId: r._id,
    name: r.name,
    size: r.size,
    submittedBy: v.submittedBy,
    submittedAt: v.submittedAt,
    versionRevision: v.revision,
  };
}
async function feedback(c, r) {
  const { t, p, m } = await c.task(r.taskId, { full: true });
  check(
    (m.role === "LEADER" && r.reviewedBy === c.actor) ||
      (t.assigneeId === c.actor && t.assignmentEpoch === r.assignmentEpoch),
  );
  const s = await c.get("submissions", r.submissionId);
  return {
    reviewId: r._id,
    projectId: p._id,
    projectName: p.fields.name,
    taskId: t._id,
    taskTitle: s.taskRequirementsSnapshot.title,
    leaderDisplayName: await name(c, r.reviewedBy),
    assigneeDisplayName: await name(c, s.submittedBy),
    assignmentEpoch: r.assignmentEpoch,
    submissionId: s._id,
    displayNumber: s.displayNumber,
    originalSubmittedAt: s.submittedAt,
    reason: r.reason || "",
    priority: r.priority || "NORMAL",
    newDueAt: r.newDueAt ?? null,
    effectiveDueAt: t.dueAt,
    reviewedAt: r.reviewedAt,
    fileAvailability: (await submission(c, s)).fileAvailability,
    canResubmit:
      t.latestReviewId === r._id &&
      t.assigneeId === c.actor &&
      t.assignmentEpoch === r.assignmentEpoch &&
      t.state === "CHANGES_REQUESTED" &&
      p.status === "ACTIVE",
  };
}
async function task(c, t) {
  const { p, m } = await c.member(t.projectId);
  const full = m.role === "LEADER" || t.assigneeId === c.actor;
  const out = {
    view: full ? "FULL" : "SUMMARY",
    taskId: t._id,
    projectId: t.projectId,
    title: t.title,
    assigneeDisplayName: await name(c, t.assigneeId),
    effectiveDueAt: t.dueAt,
    state: t.state,
    isOverdue: overdue(t, c.now),
    hasSubmitted: !!t.latestSubmissionId,
  };
  if (!full) return out;
  const active = p.status === "ACTIVE",
    owner = t.assigneeId === c.actor,
    manager = m.role === "LEADER" && active,
    editable = owner && active && pending(t);
  return {
    ...out,
    assigneeId: t.assigneeId,
    description: t.description || "",
    requirements: t.requirements || "",
    assignmentEpoch: t.assignmentEpoch,
    revision: t.revision,
    draft: owner ? t.draft || null : null,
    currentSubmission: t.latestSubmissionId
      ? await submission(c, await c.get("submissions", t.latestSubmissionId))
      : null,
    latestFeedback: t.latestReviewId
      ? await feedback(c, await c.get("reviews", t.latestReviewId))
      : null,
    editDraft: manager && t.editDraft ? taskDraft(t.editDraft) : null,
    capabilities: {
      canFirstUpload: editable && ["TODO", "DOING"].includes(t.state),
      canSaveDraft: editable && !!t.draft,
      canSubmit: editable && !!t.draft,
      canResubmit: editable && t.state === "CHANGES_REQUESTED",
      canViewFile: !!t.latestSubmissionId || (owner && !!t.draft),
      canViewHistory: !!t.latestSubmissionId,
      canViewFeedback: !!t.latestReviewId,
      canManage: manager,
      canApprove: manager && t.state === "SUBMITTED",
      canReject: manager && t.state === "SUBMITTED",
      canDelete: manager,
      canRemind: manager && pending(t),
    },
  };
}
async function project(c, p) {
  const { m } = await c.member(p._id);
  const ts = await c.db.query("tasks", {
    projectId: p._id,
    publication: "PUBLISHED",
    deletedAt: null,
  });
  return {
    projectId: p._id,
    myRole: m.role,
    ownerId: p.ownerId,
    ownerDisplayName: await name(c, p.ownerId),
    fields: p.fields,
    status: p.status,
    inviteCode: p.inviteCode,
    coverRevisionId: p.coverRevisionId || null,
    createdAt: p.createdAt,
    revision: p.revision,
    statistics: stats(ts, c.now),
  };
}
async function reference(c, f) {
  const r = await c.get("file_revisions", f.currentRevisionId);
  return {
    referenceId: f._id,
    projectId: f.projectId,
    revisionId: r._id,
    name: r.name,
    extension: r.name.split(".").pop().toLowerCase(),
    size: r.size,
    category: f.category,
    description: f.description,
    uploadedBy: r.createdBy,
    uploaderDisplayName: await name(c, r.createdBy),
    uploadedAt: r.createdAt,
    revision: f.revision,
  };
}
module.exports = {
  user,
  draft,
  taskDraft,
  name,
  submission,
  version,
  feedback,
  task,
  project,
  reference,
};
