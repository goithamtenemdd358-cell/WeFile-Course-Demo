"use strict";
const Ajv = require("ajv/dist/2020");
const schema = require("./contracts.schema.json");
const contracts = require("./api-contract.json");
const { id, fresh, hash, stable, Fault, check } = require("./core");
const Context = require("./context");
const dto = require("./projections");
const uploads = require("./uploads");
const { reads, writes } = require("./reads");
const handlers = {
  ...require("./projects"),
  ...require("./tasks"),
  ...require("./submissions"),
  ...writes,
  "file.beginUpload": uploads.begin,
};
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, "contract");
const validators = Object.fromEntries(
  contracts.map((a) => [
    a.action,
    {
      req: ajv.compile({ $ref: `contract${a.requestSchema}` }),
      res: ajv.compile({ $ref: `contract${a.responseSchema}` }),
    },
  ]),
);
/** The same domain service runs behind CloudBase and in local transaction tests.
 * File I/O is deliberately outside retryable database transactions.
 */
class Service {
  constructor(
    db,
    storage,
    { secret, now = () => Date.now(), readOnly = false, filesEnabled = true } = {},
  ) {
    check(
      secret && secret.length >= 32,
      "INTERNAL_ERROR",
      "配置至少32位的 WATERMARK_SECRET",
    );
    Object.assign(this, { db, storage, secret, now, readOnly, filesEnabled });
  }
  ctx(db, actor) {
    return new Context(db, actor, this.now(), this.storage, this.secret);
  }
  async invoke(identity, event) {
    const requestId = (event && event.requestId) || null;
    try {
      check(identity, "UNAUTHENTICATED");
      check(
        event &&
          typeof event === "object" &&
          Object.keys(event).every((k) =>
            ["action", "payload", "requestId"].includes(k),
          ),
        "INVALID_INPUT",
      );
      const { action } = event;
      let p = event.payload || {};
      if (
        ["invite.lookup", "project.join"].includes(action) &&
        typeof p.code === "string"
      )
        p = { ...p, code: p.code.trim().toUpperCase() };
      const v = validators[action];
      check(v && v.req(p), "INVALID_INPUT", "请求字段或格式不正确");
      if (this.readOnly && contracts.find((a) => a.action === action).write)
        check(false, "INVALID_STATE", "系统正在备份维护，请稍后保存");
      if (!this.filesEnabled && action.startsWith("file."))
        check(false, "INVALID_STATE", "文件存储权限尚未配置完成，暂不可上传或下载");
      const actor = id("user", identity);
      const c = this.ctx(this.db, actor);
      let data;
      if (action === "auth.bootstrap") {
        data = await this.db.transaction(async (db) => {
          let u = await db.get("users", actor);
          if (!u) {
            check(!this.readOnly, "INVALID_STATE", "系统正在维护，请稍后登录");
            u = {
              _id: actor,
              displayName: "",
              avatarRevisionId: null,
              profileComplete: false,
              revision: 0,
              nextNoticeSeq: 0,
              noticeReadThroughSeq: 0,
            };
            await db.put("users", actor, u);
          }
          return { user: dto.user(u), needsProfile: !u.profileComplete };
        });
      } else {
        const u = await c.user();
        if (
          !action.startsWith("user.") &&
          !(action === "file.beginUpload" && p.purpose === "AVATAR") &&
          !["file.finalizeUpload", "file.getReadTicket"].includes(action)
        )
          check(u.profileComplete, "PROFILE_REQUIRED");
        if (action === "file.finalizeUpload")
          data = await this.finalize(actor, p, requestId);
        else if (action === "file.getReadTicket") {
          const r = await uploads.target(c, p);
          const ticket = await this.storage.ticket(r.blobId);
          data = {
            downloadUrl: ticket.url,
            expiresAt: ticket.expiresAt || null,
            expiryNote: "临时授权链接；已经下载的副本无法远程收回",
            name: r.name,
            size: r.size,
            sha256: r.sha256,
          };
        } else if (reads[action]) data = await reads[action](c, p);
        else if (action === "project.draftGet")
          data = await handlers[action](c, p);
        else if (action === "invite.lookup") {
          check(!this.readOnly, "INVALID_STATE", "系统正在维护");
          const rate = await this.db.transaction((db) =>
            handlers[action](this.ctx(db, actor), p),
          );
          check(rate.lookupAllowed, "RATE_LIMITED", "查询过于频繁，请稍后再试");
          const invite = await c.db.get(
            "invite_codes",
            id("invite", p.code.trim().toUpperCase()),
          );
          check(invite, "INVITE_INVALID");
          check(
            invite.active && (!invite.expiresAt || invite.expiresAt > c.now),
            "INVITE_INACTIVE",
          );
          const project = await c.get("projects", invite.projectId);
          check(project.status === "ACTIVE", "PROJECT_ARCHIVED");
          data = {
            projectName: project.fields.name,
            description: project.fields.description || "",
            ownerDisplayName: await dto.name(c, project.ownerId),
            dueAt: project.fields.dueAt,
          };
        } else {
          check(handlers[action], "INVALID_INPUT");
          check(
            typeof requestId === "string" &&
              requestId.length >= 8 &&
              requestId.length <= 128,
            "INVALID_INPUT",
            "写操作需要请求编号",
          );
          const key = id("op", actor, requestId),
            fingerprint = hash(JSON.stringify(stable({ action, p })));
          const result = await this.db.transaction(async (db) => {
            const tx = this.ctx(db, actor);
            const old = await db.get("operations", key);
            if (old) {
              check(old.payloadHash === fingerprint, "IDEMPOTENCY_CONFLICT");
              await this.authorizeReplay(tx, action, p, old.result);
              return old.result;
            }
            const result = await handlers[action](tx, p);
            await tx.audit(action, key, {
              resultRefs: result.taskId ? [result.taskId] : [],
            });
            await db.put("operations", key, {
              _id: key,
              actorId: actor,
              action,
              payloadHash: fingerprint,
              result,
              createdAt: tx.now,
            });
            return result;
          });
          data = await this.materialize(c, action, result);
        }
      }
      check(v.res(data), "INTERNAL_ERROR", `响应契约不匹配：${action}`);
      return { ok: true, data, requestId, serverNow: this.now() };
    } catch (e) {
      if (!(e instanceof Fault)) console.error("api failure", e.message);
      return {
        ok: false,
        error: {
          code: ["FORBIDDEN", "NOT_ACCESSIBLE"].includes(e.code)
            ? "NOT_ACCESSIBLE"
            : e.code &&
                schema.$defs.ErrorDTO.properties.code.enum.includes(e.code)
              ? e.code
              : "INTERNAL_ERROR",
          message: ["FORBIDDEN", "NOT_ACCESSIBLE"].includes(e.code)
            ? "内容不存在或不可访问"
            : e instanceof Fault
              ? e.message
              : "服务暂时不可用，请稍后重试",
          retryable: [
            "STORAGE_ERROR",
            "UPLOAD_NOT_READY",
            "INTERNAL_ERROR",
          ].includes(e.code),
        },
        requestId,
        serverNow: this.now(),
      };
    }
  }
  async authorizeReplay(c, a, p, result) {
    if (a.startsWith("user.") || a.startsWith("notification.")) return;
    if (a === "file.beginUpload") {
      const session = await c.get("upload_sessions", result.uploadSessionId);
      check(session.actorId === c.actor);
      await c.uploadScope(session);
      check(session.expiresAt > c.now, "UPLOAD_NOT_READY");
      return;
    }
    if (a.startsWith("project.draft")) {
      await c.draft(p.draftId || result.draftId);
      return;
    }
    if (a === "project.publish") {
      await c.member(result.projectId, true);
      return;
    }
    if (a === "project.join") {
      await c.member(result.projectId);
      return;
    }
    if (a.startsWith("submission.")) {
      const { t } = await c.task(p.taskId, { owner: true });
      const revision = await c.get("file_revisions", p.revisionId);
      check(revision.assignmentEpoch === t.assignmentEpoch, "STALE_REVISION");
      return;
    }
    if (a.startsWith("review.")) {
      const s = await c.get("submissions", p.submissionId);
      await c.member(s.projectId, true);
      return;
    }
    if (a.startsWith("task.")) {
      const t = await c.get(
        "tasks",
        p.taskId || result.taskId || p.draftTaskId || result.draftTaskId,
      );
      await c.member(t.projectId, true);
      return;
    }
    await c.member(p.projectId, true);
  }
  async materialize(c, a, r) {
    if (["task.publish", "task.update", "submission.saveDraft"].includes(a))
      return dto.task(c, (await c.task(r.taskId, { full: true })).t);
    if (a === "submission.submit") {
      const s = await c.get("submissions", r.submissionId),
        v = await c.get("file_versions", r.visibleVersionId);
      const { t } = await c.task(r.taskId, { owner: true });
      check(
        t.latestSubmissionId === s._id && v.currentRevisionId === s.revisionId,
        "STALE_REVISION",
        "该操作已完成，但后续版本已变化，请刷新任务",
      );
      return {
        task: await dto.task(c, (await c.task(r.taskId, { owner: true })).t),
        submission: await dto.submission(
          c,
          await c.get("submissions", r.submissionId),
        ),
        visibleVersion: await dto.version(
          c,
          await c.get("file_versions", r.visibleVersionId),
        ),
      };
    }
    if (a.startsWith("review.") && r.taskId)
      return {
        task: await dto.task(c, (await c.task(r.taskId, { leader: true })).t),
        reviewId: r.reviewId,
      };
    if (a === "project.update")
      return dto.project(c, await c.get("projects", r.projectId));
    if (a === "reference.create")
      return dto.reference(c, await c.get("files", r.referenceId));
    return r;
  }
  async finalize(actor, p, requestId) {
    check(
      typeof requestId === "string" && requestId.length >= 8,
      "INVALID_INPUT",
    );
    const s = await this.db.transaction((db) =>
      uploads.acquire(this.ctx(db, actor), p, requestId),
    );
    if (s.state === "SEALED") {
      const r = await this.ctx(this.db, actor).get(
        "file_revisions",
        s.sealedRevisionId,
      );
      check(["SEALED", "VISIBLE"].includes(r.lifecycle), "NOT_ACCESSIBLE");
      return {
        revisionId: r._id,
        name: r.name,
        size: r.size,
        sha256: r.sha256,
      };
    }
    try {
      const bytes = await this.storage.readTemporary(
        p.tempFileId,
        s.tempPath,
        uploads.MAX,
      );
      uploads.validateBytes(s.name, bytes);
      const revisionId = s.attemptRevisionId;
      const blobId = await this.storage.seal(s.attemptPath, bytes);
      await this.db.transaction(async (db) => {
        const current = await db.get("upload_sessions", s._id);
        const attempt = current.attempts.find(
          (a) => a.revisionId === revisionId,
        );
        if (attempt) attempt.blobId = blobId;
        await db.put("upload_sessions", current._id, current);
      });
      return await this.db.transaction((db) =>
        uploads.seal(this.ctx(db, actor), p, s, bytes, blobId, revisionId),
      );
    } catch (e) {
      await this.db.transaction(async (db) => {
        const current = await db.get("upload_sessions", s._id);
        if (
          current &&
          current.leaseToken === s.leaseToken &&
          current.state === "SEALING"
        ) {
          current.state = "OPEN";
          await db.put("upload_sessions", s._id, current);
        }
      });
      throw e;
    }
  }
  async reminders() {
    check(!this.readOnly, "INVALID_STATE", "系统正在维护");
    const rows = await this.db.query("tasks", {
      publication: "PUBLISHED",
      deletedAt: null,
    });
    let created = 0;
    for (const row of rows) {
      const result = await this.db.transaction(async (db) => {
        const c = this.ctx(db, "SYSTEM");
        const t = await db.get("tasks", row._id);
        if (
          !t ||
          t.deletedAt ||
          !["TODO", "DOING", "CHANGES_REQUESTED"].includes(t.state)
        )
          return false;
        const p = await db.get("projects", t.projectId);
        const m = await db.get(
          "project_members",
          id(t.projectId, t.assigneeId),
        );
        if (!p || p.status !== "ACTIVE" || !m || !m.active) return false;
        const delta = t.dueAt - c.now;
        if (delta > 86400000) return false;
        const type = delta < 0 ? "OVERDUE" : "DUE_SOON";
        const r = await c.notify(
          t,
          type,
          delta < 0 ? p.ownerId : t.assigneeId,
          id(t._id, t.assignmentEpoch, t.dueRevision, type),
        );
        return r.created;
      });
      if (result) created++;
    }
    return { created };
  }
}
module.exports = {
  Service,
  validators,
  implementedActions: new Set([
    ...Object.keys(handlers),
    ...Object.keys(reads),
    "auth.bootstrap",
    "file.finalizeUpload",
    "file.getReadTicket",
  ]),
};
