"use strict";
const crypto = require("node:crypto");
const { id, check, page, stats, overdue } = require("./core");
const dto = require("./projections");
const sign = (c, n) =>
  crypto.createHmac("sha256", c.secret).update(`${c.actor}:${n}`).digest("hex");
async function mappedPage(rows, p, key, map) {
  const result = page(rows, p, key);
  return { ...result, items: await Promise.all(result.items.map(map)) };
}
const filter = (t, f, now) =>
  f === "ALL" ||
  (f === "PENDING" && ["TODO", "DOING"].includes(t.state)) ||
  (f === "OVERDUE" && overdue(t, now)) ||
  f === t.state;
async function tasks(c, projectId) {
  await c.member(projectId);
  return c.db.query("tasks", {
    projectId,
    publication: "PUBLISHED",
    deletedAt: null,
  });
}
async function notices(c) {
  return c.db.query("notifications", { recipientId: c.actor });
}
async function count(c) {
  const u = await c.user();
  return (await notices(c)).filter(
    (n) => n.noticeSeq > u.noticeReadThroughSeq && !n.readAt,
  ).length;
}
const reads = {
  "user.get": async (c) => dto.user(await c.user()),
  "user.logout": async () => ({ loggedOut: true }),
  "project.get": async (c, p) =>
    dto.project(c, (await c.member(p.projectId)).p),
  async "project.list"(c, p) {
    const ms = await c.db.query("project_members", {
      userId: c.actor,
      active: true,
    });
    return mappedPage(ms, p, "projectId", async (m) => {
      const project = await dto.project(
        c,
        await c.get("projects", m.projectId),
      );
      return {
        projectId: m.projectId,
        name: project.fields.name,
        myRole: m.role,
        dueAt: project.fields.dueAt,
        progress: project.statistics.progress,
        statusText: `${project.statistics.awaitingReview}项待审核`,
        status: project.status,
      };
    });
  },
  async "home.get"(c) {
    const ms = await c.db.query("project_members", {
      userId: c.actor,
      active: true,
    });
    const selected = [],
      leaders = ms.filter((m) => m.role === "LEADER");
    for (const m of ms) {
      const rows = await tasks(c, m.projectId);
      selected.push(
        ...rows.filter((t) => m.role === "LEADER" || t.assigneeId === c.actor),
      );
    }
    const s = stats(selected, c.now);
    return {
      user: dto.user(await c.user()),
      view: !ms.length ? "EMPTY" : leaders.length ? "LEADER" : "MEMBER",
      awaitingReview: leaders.length
        ? selected.filter(
            (t) =>
              t.state === "SUBMITTED" &&
              leaders.some((m) => m.projectId === t.projectId),
          ).length
        : null,
      pending: s.pending,
      changesRequested: s.changesRequested,
      overdue: s.overdue,
      hasProjects: !!ms.length,
      unreadCount: await count(c),
    };
  },
  async "member.list"(c, p) {
    await c.member(p.projectId);
    const rows = await c.db.query("project_members", {
      projectId: p.projectId,
      active: true,
    });
    return mappedPage(rows, p, "userId", async (m) => ({
      userId: m.userId,
      displayName: await dto.name(c, m.userId),
      role: m.role,
    }));
  },
  async "reference.list"(c, p) {
    await c.member(p.projectId);
    const rows = await c.db.query("files", {
      projectId: p.projectId,
      scope: "REFERENCE",
      deletedAt: null,
    });
    return mappedPage(
      rows.filter((r) => !p.category || r.category === p.category),
      p,
      "_id",
      (r) => dto.reference(c, r),
    );
  },
  async "task.get"(c, p) {
    return dto.task(c, (await c.task(p.taskId)).t);
  },
  async "task.list"(c, p) {
    const rows = await tasks(c, p.projectId);
    return {
      ...(await mappedPage(
        rows.filter((t) => filter(t, p.filter, c.now)),
        p,
        "_id",
        (t) => dto.task(c, t),
      )),
      statistics: stats(rows, c.now),
    };
  },
  async "task.listMine"(c, p) {
    const rows = (await tasks(c, p.projectId)).filter(
      (t) => t.assigneeId === c.actor && filter(t, p.filter, c.now),
    );
    return mappedPage(rows, p, "_id", (t) => dto.task(c, t));
  },
  async "my.todoList"(c, p) {
    const ms = await c.db.query("project_members", {
      userId: c.actor,
      active: true,
    });
    const rows = [];
    for (const m of ms) {
      rows.push(
        ...(await tasks(c, m.projectId)).filter(
          (t) => t.assigneeId === c.actor,
        ),
      );
    }
    const pendingRows = rows.filter((t) => ["TODO", "DOING"].includes(t.state)),
      changes = rows.filter((t) => t.state === "CHANGES_REQUESTED");
    return {
      ...(await mappedPage(
        p.tab === "pending" ? pendingRows : changes,
        p,
        "_id",
        async (t) => ({
          taskId: t._id,
          projectId: t.projectId,
          projectName: (await c.get("projects", t.projectId)).fields.name,
          title: t.title,
          dueAt: t.dueAt,
          state: t.state,
          isOverdue: overdue(t, c.now),
          quickAction:
            t.state === "CHANGES_REQUESTED" ? "RESUBMIT" : "FIRST_UPLOAD",
        }),
      )),
      pendingCount: pendingRows.length,
      changesCount: changes.length,
      todoCount: pendingRows.length + changes.length,
    };
  },
  async "task.draftList"(c, p) {
    await c.member(p.projectId, true);
    return mappedPage(
      await c.db.query("tasks", {
        projectId: p.projectId,
        publication: "DRAFT",
        deletedAt: null,
      }),
      p,
      "_id",
      dto.taskDraft,
    );
  },
  async "version.list"(c, p) {
    const { t, m } = await c.task(p.taskId, { full: true });
    const epoch = p.assignmentEpoch || t.assignmentEpoch;
    check(m.role === "LEADER" || epoch === t.assignmentEpoch);
    return mappedPage(
      await c.db.query("file_versions", {
        taskId: t._id,
        assignmentEpoch: epoch,
      }),
      p,
      "_id",
      (v) => dto.version(c, v),
    );
  },
  async "review.get"(c, p) {
    return dto.feedback(c, await c.get("reviews", p.reviewId));
  },
  async "review.context"(c, p) {
    const s = await c.get("submissions", p.submissionId);
    const { t, p: project } = await c.task(s.taskId, { leader: true });
    return {
      submission: await dto.submission(c, s),
      assigneeDisplayName: await dto.name(c, s.submittedBy),
      taskRequirementsSnapshot: s.taskRequirementsSnapshot,
      expectedTaskRevision: t.revision,
      effectiveDueAt: t.dueAt,
      canReview:
        project.status === "ACTIVE" &&
        t.state === "SUBMITTED" &&
        t.latestSubmissionId === s._id &&
        s.decision === "PENDING",
    };
  },
  async "review.list"(c, p) {
    await c.member(p.projectId, true);
    const rows = await c.db.query("submissions", {
      projectId: p.projectId,
      decision: p.filter,
    });
    const valid = [];
    for (const s of rows) {
      if (
        (p.taskId && s.taskId !== p.taskId) ||
        (p.submissionId && s._id !== p.submissionId)
      )
        continue;
      const t = await c.db.get("tasks", s.taskId);
      if (t && !t.deletedAt) valid.push(s);
    }
    return mappedPage(valid, p, "_id", async (s) => {
      const ctx = await reads["review.context"](c, { submissionId: s._id });
      const { t } = await c.task(s.taskId, { leader: true });
      return {
        submission: ctx.submission,
        assigneeDisplayName: ctx.assigneeDisplayName,
        taskTitle: s.taskRequirementsSnapshot.title,
        expectedTaskRevision: t.revision,
        currentState: t.state,
        isCurrent: t.latestSubmissionId === s._id,
        canApprove: ctx.canReview,
        canReject: ctx.canReview,
      };
    });
  },
  async "notification.list"(c, p) {
    const u = await c.user(),
      throughSeq = u.nextNoticeSeq;
    const rows = (await notices(c)).filter(
      (n) =>
        n.noticeSeq <= throughSeq &&
        (p.category === "ALL" || n.category === p.category),
    );
    let before = throughSeq + 1;
    if (p.cursor) {
      before = Number(p.cursor);
      check(Number.isSafeInteger(before) && before > 0, "INVALID_INPUT");
    }
    const selected = rows
      .filter((n) => n.noticeSeq < before)
      .sort((a, b) => b.noticeSeq - a.noticeSeq);
    const slice = selected.slice(0, p.pageSize || 20);
    return {
      items: await Promise.all(
        slice.map(async (n) => {
          const project = await c.get("projects", n.projectId);
          const target = {
            submissionId: null,
            reviewId: null,
            pageId:
              n.eventType === "CHANGES_REQUESTED"
                ? "19"
                : ["FIRST_SUBMITTED", "RESUBMITTED"].includes(n.eventType)
                  ? "16"
                  : "12",
            projectId: n.projectId,
            taskId: n.taskId,
          };
          if (n.reviewId && target.pageId === "19")
            target.reviewId = n.reviewId;
          if (n.submissionId && target.pageId === "16")
            target.submissionId = n.submissionId;
          return {
            notificationId: n._id,
            noticeSeq: n.noticeSeq,
            category: n.category,
            eventType: n.eventType,
            projectId: n.projectId,
            projectName: project.fields.name,
            taskId: n.taskId,
            taskTitle: n.taskTitle,
            senderDisplayName:
              n.senderId === "SYSTEM" ? "系统" : await dto.name(c, n.senderId),
            eventAt: n.createdAt,
            isRead: !!n.readAt || n.noticeSeq <= u.noticeReadThroughSeq,
            target,
          };
        }),
      ),
      nextCursor:
        selected.length > slice.length ? String(slice.at(-1).noticeSeq) : null,
      total: rows.length,
      watermark: { throughSeq, token: sign(c, throughSeq) },
    };
  },
  "notification.unreadCount": async (c) => ({
    count: await count(c),
    serverNow: c.now,
  }),
};
const writes = {
  async "notification.readAll"(c, p) {
    const u = await c.user();
    check(
      p.watermark.token === sign(c, p.watermark.throughSeq) &&
        p.watermark.throughSeq <= u.nextNoticeSeq,
      "INVALID_INPUT",
    );
    u.noticeReadThroughSeq = Math.max(
      u.noticeReadThroughSeq,
      p.watermark.throughSeq,
    );
    await c.db.put("users", u._id, u);
    return { readThroughSeq: u.noticeReadThroughSeq };
  },
  async "notification.read"(c, p) {
    const k = p.notificationId || id("CHANGES_REQUESTED", p.reviewId, c.actor);
    const n = await c.db.get("notifications", k);
    if (!n && !p.notificationId) return { read: true, matchedCount: 0 };
    check(n && n.recipientId === c.actor);
    n.readAt = n.readAt || c.now;
    await c.db.put("notifications", k, n);
    return { read: true, matchedCount: 1 };
  },
};
module.exports = { reads, writes };
