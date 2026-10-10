"use strict";
const { id, check, cas, pending } = require("./core");
/** Request-scoped trusted identity and authorization. No client-provided role is accepted.
 * @typedef {{get: Function, put: Function, query: Function, transaction?: Function}} Repository
 */
class Context {
  constructor(db, actor, now, storage, secret) {
    Object.assign(this, { db, actor, now, storage, secret });
  }
  async get(c, k) {
    const v = await this.db.get(c, k);
    check(v, "NOT_ACCESSIBLE", "内容不存在或不可访问");
    return v;
  }
  async user() {
    return this.get("users", this.actor);
  }
  async member(projectId, leader = false, write = false) {
    const p = await this.get("projects", projectId);
    const m = await this.db.get("project_members", id(projectId, this.actor));
    check(m && m.active && ["ACTIVE", "ARCHIVED"].includes(p.status));
    if (leader) check(m.role === "LEADER");
    if (write) check(p.status === "ACTIVE", "PROJECT_ARCHIVED");
    return { p, m };
  }
  async task(
    taskId,
    { full = false, owner = false, leader = false, write = false } = {},
  ) {
    const t = await this.get("tasks", taskId);
    check(!t.deletedAt && t.publication === "PUBLISHED", "NOT_ACCESSIBLE");
    const { p, m } = await this.member(t.projectId, leader, write);
    if (full) check(m.role === "LEADER" || t.assigneeId === this.actor);
    if (owner) check(t.assigneeId === this.actor);
    return { t, p, m };
  }
  async draft(key) {
    const d = await this.get("projects", key);
    check(d.status === "DRAFT" && d.creatorId === this.actor);
    if (d.mode === "EDIT") await this.member(d.projectId, true, true);
    return d;
  }
  async uploadScope(s) {
    if (s.purpose === "AVATAR")
      return { budgetCollection: "users", budgetId: this.actor };
    if (s.purpose.endsWith("_DRAFT") && s.purpose !== "TASK_DRAFT") {
      const d = await this.draft(s.draftKey);
      return {
        budgetCollection: "projects",
        budgetId: d.mode === "EDIT" ? d.projectId : d._id,
      };
    }
    if (s.purpose === "PROJECT_REFERENCE") {
      await this.member(s.projectId, true, true);
      return { budgetCollection: "projects", budgetId: s.projectId };
    }
    check(s.purpose === "TASK_DRAFT", "INVALID_INPUT");
    const { t } = await this.task(s.taskId, { owner: true, write: true });
    check(pending(t), "INVALID_STATE");
    if (s.assignmentEpoch !== undefined)
      check(t.assignmentEpoch === s.assignmentEpoch, "STALE_REVISION");
    if (s.projectId) check(s.projectId === t.projectId);
    return {
      budgetCollection: "projects",
      budgetId: t.projectId,
      assignmentEpoch: t.assignmentEpoch,
      projectId: t.projectId,
    };
  }
  async notify(t, eventType, recipientId, eventKey, extra = {}) {
    const notificationId = id(eventType, eventKey, recipientId);
    if (await this.db.get("notifications", notificationId))
      return { notificationId, created: false };
    const u = await this.get("users", recipientId);
    u.nextNoticeSeq++;
    await this.db.put("users", u._id, u);
    const category =
      eventType === "CHANGES_REQUESTED"
        ? "FEEDBACK"
        : eventType === "APPROVED"
          ? "REVIEW_RESULT"
          : "TASK";
    await this.db.put("notifications", notificationId, {
      _id: notificationId,
      recipientId,
      senderId: this.actor,
      projectId: t.projectId,
      taskId: t._id,
      taskTitle: t.title,
      eventType,
      category,
      noticeSeq: u.nextNoticeSeq,
      createdAt: this.now,
      readAt: null,
      ...extra,
    });
    return { notificationId, created: true };
  }
  async audit(eventType, key, details = {}) {
    const k = id(eventType, key);
    await this.db.put("audit_events", k, {
      _id: k,
      actorId: this.actor,
      eventType,
      createdAt: this.now,
      ...details,
    });
  }
}
module.exports = Context;
