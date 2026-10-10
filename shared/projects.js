"use strict";
const { id, fresh, check, cas, page, stats } = require("./core");
const dto = require("./projections");
const crypto = require("node:crypto");
const fields = (f) => ({
  ...f,
  name: (f.name || "").trim(),
  description: f.description || "",
  unifiedRequirements: f.unifiedRequirements || "",
  finalRequirements: f.finalRequirements || "",
  timezone: "Asia/Shanghai",
});
const completedFields = (f, now) => ({
  ...fields(f),
  name: (f.name || "").trim() || "未命名项目",
  dueAt: Number.isInteger(f.dueAt) ? f.dueAt : now + 7 * 86400000,
});
async function asset(c, rid, d, purpose) {
  const r = await c.get("file_revisions", rid);
  check(
    r.createdBy === c.actor &&
      r.draftKey === d._id &&
      r.purpose === purpose &&
      r.lifecycle === "SEALED",
  );
  r.attached = true;
  await c.db.put("file_revisions", r._id, r);
  return r;
}
async function references(c, d, p) {
  check(
    d.referenceInputs.length * 6 + 20 <= 90,
    "TRANSACTION_BUDGET_EXCEEDED",
    "参考文档超过单次原子发布预算，请减少后重试",
  );
  const seen = new Set(),
    result = [];
  for (const x of d.referenceInputs) {
    check(!seen.has(x.revisionId), "INVALID_INPUT");
    seen.add(x.revisionId);
    if (x.referenceId) {
      const f = await c.get("files", x.referenceId);
      check(
        f.projectId === p._id &&
          f.scope === "REFERENCE" &&
          !f.deletedAt &&
          f.currentRevisionId === x.revisionId,
      );
      result.push({
        ...f,
        category: x.category,
        description: x.description,
        revision: f.revision + 1,
      });
    } else {
      await asset(c, x.revisionId, d, "PROJECT_REFERENCE_DRAFT");
      const k = id(p._id, x.revisionId);
      result.push({
        _id: k,
        projectId: p._id,
        scope: "REFERENCE",
        currentRevisionId: x.revisionId,
        category: x.category,
        description: x.description,
        revision: 1,
        deletedAt: null,
      });
    }
  }
  return result;
}
module.exports = {
  async "user.update"(c, p) {
    const u = await c.user();
    cas(u.revision, p.expectedRevision);
    const displayName = (p.displayName || "").trim() || "微信用户";
    if (p.avatarRevisionId) {
      const r = await c.get("file_revisions", p.avatarRevisionId);
      check(
        r.createdBy === c.actor &&
          r.purpose === "AVATAR" &&
          r.lifecycle === "SEALED",
      );
      r.attached = true;
      await c.db.put("file_revisions", r._id, r);
      u.avatarRevisionId = r._id;
    }
    u.displayName = displayName;
    u.profileComplete = true;
    u.revision++;
    await c.db.put("users", u._id, u);
    return dto.user(u);
  },
  async "project.draftOpen"(c, p) {
    let parent = null;
    if (p.mode === "EDIT") parent = (await c.member(p.projectId, true, true)).p;
    const u = await c.user(),
      scope = p.mode + ":" + (p.projectId || "");
    u.projectDraftIds = u.projectDraftIds || {};
    let k = u.projectDraftIds[scope];
    let d = k ? await c.db.get("projects", k) : null;
    if (!d || d.status !== "DRAFT") {
      k = fresh();
      u.projectDraftIds[scope] = k;
      await c.db.put("users", u._id, u);
      d = {
        _id: k,
        status: "DRAFT",
        mode: p.mode,
        projectId: p.projectId || null,
        creatorId: c.actor,
        saved: false,
        fields: parent ? parent.fields : { timezone: "Asia/Shanghai" },
        referenceInputs: parent ? parent.referenceInputs || [] : [],
        coverRevisionId: parent ? parent.coverRevisionId : null,
        baseProjectRevision: parent ? parent.revision : null,
        draftRevision: 0,
        storageBudget: { reservedBytes: 0, sealedBytes: 0, revision: 0 },
      };
      await c.db.put("projects", k, d);
    }
    return dto.draft(d);
  },
  async "project.draftGet"(c, p) {
    const u = await c.user();
    const k =
      p.draftId ||
      (u.projectDraftIds || {})[p.mode + ":" + (p.projectId || "")];
    if (!k) return null;
    const d = await c.db.get("projects", k);
    if (!d || d.status !== "DRAFT") return null;
    await c.draft(k);
    return d.saved ? dto.draft(d) : null;
  },
  async "project.draftSave"(c, p) {
    const d = await c.draft(p.draftId);
    check(d.mode === p.mode, "INVALID_INPUT");
    cas(d.draftRevision, p.expectedDraftRevision);
    if (p.coverRevisionId && p.coverRevisionId !== d.coverRevisionId)
      await asset(c, p.coverRevisionId, d, "PROJECT_COVER_DRAFT");
    const seen = new Set();
    for (const x of p.referenceInputs) {
      check(!seen.has(x.revisionId), "INVALID_INPUT");
      seen.add(x.revisionId);
      if (x.referenceId) {
        check(d.mode === "EDIT");
        const f = await c.get("files", x.referenceId);
        check(
          f.projectId === d.projectId &&
            f.scope === "REFERENCE" &&
            !f.deletedAt &&
            f.currentRevisionId === x.revisionId,
        );
      } else await asset(c, x.revisionId, d, "PROJECT_REFERENCE_DRAFT");
    }
    d.fields = p.fields;
    d.coverRevisionId = p.coverRevisionId || null;
    d.referenceInputs = p.referenceInputs;
    d.saved = true;
    d.draftRevision++;
    await c.db.put("projects", d._id, d);
    return dto.draft(d);
  },
  async "project.publish"(c, p) {
    const d = await c.draft(p.draftId);
    check(d.mode === "NEW" && d.saved, "INVALID_STATE");
    cas(d.draftRevision, p.expectedDraftRevision);
    const f = completedFields(d.fields, c.now);
    let code, codeId;
    for (let n = 0; n < 10; n++) {
      code = Array.from(
        { length: 6 },
        () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[crypto.randomInt(32)],
      ).join("");
      codeId = id("invite", code);
      if (!(await c.db.get("invite_codes", codeId))) break;
      code = null;
    }
    check(code, "INTERNAL_ERROR");
    const projectId = fresh();
    const project = {
      _id: projectId,
      status: "ACTIVE",
      creatorId: c.actor,
      ownerId: c.actor,
      fields: f,
      inviteCode: code,
      revision: 1,
      createdAt: c.now,
      coverRevisionId: d.coverRevisionId || null,
      storageBudget: d.storageBudget,
      referenceInputs: [],
    };
    if (d.coverRevisionId)
      await asset(c, d.coverRevisionId, d, "PROJECT_COVER_DRAFT");
    const refs = await references(c, d, project);
    for (const r of refs) {
      await c.db.put("files", r._id, r);
      project.referenceInputs.push({
        referenceId: r._id,
        revisionId: r.currentRevisionId,
        category: r.category,
        description: r.description,
      });
    }
    await c.db.put("projects", projectId, project);
    await c.db.put("invite_codes", codeId, {
      _id: codeId,
      projectId,
      active: true,
      createdAt: c.now,
    });
    const mk = id(projectId, c.actor);
    await c.db.put("project_members", mk, {
      _id: mk,
      projectId,
      userId: c.actor,
      role: "LEADER",
      active: true,
      joinedAt: c.now,
    });
    d.status = "CONSUMED";
    d.publishedProjectId = projectId;
    await c.db.put("projects", d._id, d);
    return { projectId, inviteCode: code };
  },
  async "project.update"(c, p) {
    const { p: project } = await c.member(p.projectId, true, true);
    const d = await c.draft(p.draftId);
    check(d.mode === "EDIT" && d.projectId === p.projectId && d.saved);
    cas(project.revision, p.expectedRevision);
    cas(d.baseProjectRevision, p.expectedRevision);
    cas(d.draftRevision, p.expectedDraftRevision);
    const f = completedFields(d.fields, c.now);
    if (d.coverRevisionId && d.coverRevisionId !== project.coverRevisionId)
      await asset(c, d.coverRevisionId, d, "PROJECT_COVER_DRAFT");
    const refs = await references(c, d, project);
    for (const old of project.referenceInputs || []) {
      if (!refs.some((r) => r._id === old.referenceId)) {
        const file = await c.get("files", old.referenceId);
        file.deletedAt = c.now;
        file.revision++;
        await c.db.put("files", file._id, file);
      }
    }
    for (const r of refs) await c.db.put("files", r._id, r);
    project.fields = f;
    project.coverRevisionId = d.coverRevisionId;
    project.referenceInputs = refs.map((r) => ({
      referenceId: r._id,
      revisionId: r.currentRevisionId,
      category: r.category,
      description: r.description,
    }));
    project.revision++;
    await c.db.put("projects", project._id, project);
    d.status = "CONSUMED";
    await c.db.put("projects", d._id, d);
    return { projectId: project._id };
  },
  async "invite.lookup"(c, p) {
    const bucket = id("invite-rate", c.actor, Math.floor(c.now / 60000));
    const r = (await c.db.get("operations", bucket)) || {
      _id: bucket,
      count: 0,
    };
    r.count++;
    await c.db.put("operations", bucket, r);
    return { lookupAllowed: r.count <= 10, code: p.code };
  },
  async "project.join"(c, p) {
    const invite = await c.get(
      "invite_codes",
      id("invite", p.code.trim().toUpperCase()),
    );
    check(
      invite.active && (!invite.expiresAt || invite.expiresAt > c.now),
      "INVITE_INACTIVE",
    );
    const project = await c.get("projects", invite.projectId);
    check(project.status === "ACTIVE", "PROJECT_ARCHIVED");
    const k = id(project._id, c.actor),
      old = await c.db.get("project_members", k);
    const m = old || {
      _id: k,
      projectId: project._id,
      userId: c.actor,
      role: "MEMBER",
      active: true,
      joinedAt: c.now,
    };
    check(m.active);
    await c.db.put("project_members", k, m);
    return {
      projectId: project._id,
      alreadyJoined: !!old,
      member: {
        userId: c.actor,
        displayName: (await c.user()).displayName,
        role: m.role,
      },
    };
  },
  async "reference.create"(c, p) {
    const { p: project } = await c.member(p.projectId, true, true);
    const r = await c.get("file_revisions", p.revisionId);
    check(
      r.createdBy === c.actor &&
        r.projectId === p.projectId &&
        r.purpose === "PROJECT_REFERENCE" &&
        r.lifecycle === "SEALED",
    );
    r.attached = true;
    await c.db.put("file_revisions", r._id, r);
    const k = id(p.projectId, r._id);
    check(!(await c.db.get("files", k)), "INVALID_STATE");
    const f = {
      _id: k,
      projectId: p.projectId,
      scope: "REFERENCE",
      currentRevisionId: r._id,
      category: p.category,
      description: p.description,
      revision: 1,
      deletedAt: null,
    };
    await c.db.put("files", k, f);
    project.referenceInputs.push({
      referenceId: k,
      revisionId: r._id,
      category: p.category,
      description: p.description,
    });
    project.revision++;
    await c.db.put("projects", project._id, project);
    return { referenceId: k };
  },
  async "reference.delete"(c, p) {
    const { p: project } = await c.member(p.projectId, true, true);
    const f = await c.get("files", p.referenceId);
    check(
      f.projectId === p.projectId && f.scope === "REFERENCE" && !f.deletedAt,
    );
    cas(f.revision, p.expectedRevision);
    f.deletedAt = c.now;
    f.revision++;
    await c.db.put("files", f._id, f);
    project.referenceInputs = project.referenceInputs.filter(
      (x) => x.referenceId !== f._id,
    );
    project.revision++;
    await c.db.put("projects", project._id, project);
    return { deleted: true };
  },
};
