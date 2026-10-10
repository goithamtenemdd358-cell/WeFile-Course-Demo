const api = require("./api"),
  nav = require("./navigation"),
  files = require("./files"),
  fmt = require("../utils/format");
const taskFilters = [
  ["ALL", "全部"],
  ["PENDING", "待完成"],
  ["SUBMITTED", "待审核"],
  ["CHANGES_REQUESTED", "需修改"],
  ["DONE", "已完成"],
  ["OVERDUE", "已逾期"],
].map(([value, label]) => ({ value, label }));
const categories = [
  { value: "REQUIREMENT", label: "项目要求" },
  { value: "REFERENCE", label: "参考资料" },
  { value: "DATA", label: "数据资料" },
  { value: "IMAGE", label: "图片素材" },
  { value: "OTHER", label: "其他" },
];
const titles = {
  "01": "微信快捷登录",
  "02": "完善个人资料",
  "03": "首页",
  "03-A": "我的项目",
  "04": "输入邀请码",
  "05": "创建 / 编辑项目",
  "06": "项目创建成功",
  "07": "项目总览",
  "08": "项目简介",
  "09": "参考文档",
  10: "总体任务",
  11: "我的任务",
  12: "任务详情",
  13: "首次上传与提交",
  14: "创建 / 编辑任务",
  15: "组长任务概况",
  16: "审核与反馈",
  17: "填写修改意见",
  18: "消息中心",
  19: "修改意见详情",
  20: "重新提交文件",
  "02-A": "个人中心",
};
async function confirm(title, content) {
  return (await wx.showModal({ title, content })).confirm;
}
function create(pageId) {
  return {
    data: {
      pageId,
      title: titles[pageId],
      busy: false,
      loading: true,
      error: "",
      items: [],
      form: {},
      filter:
        pageId === "11"
          ? "PENDING"
          : pageId === "16"
            ? "PENDING"
            : pageId === "18"
              ? "ALL"
              : pageId === "02-A"
                ? "pending"
                : "ALL",
      taskFilters,
      categories,
      categoryIndex: 1,
      priorityIndex: 0,
      priorities: ["普通", "重要", "紧急"],
      mode: "KEEP",
      note: "",
      progress: 0,
      versions: [],
      drafts: [],
      members: [],
      referenceInputs: [],
      showVersions: false,
    },
    onLoad(options) {
      this.frame = nav.bind(pageId, options);
      this.args = this.frame.args;
      this.setData({
        canBack: !!this.frame.parent || ["07", "13", "16"].includes(pageId),
      });
      this.initialized = false;
      if (pageId === "16" && this.args.reviewFilter)
        this.setData({ filter: this.args.reviewFilter });
      if (this.frame.state.filter)
        this.setData({ filter: this.frame.state.filter });
    },
    async onShow() {
      this.visible = true;
      await this.run(() => this.load());
      if (this.frame.state.scrollTop && wx.pageScrollTo)
        wx.pageScrollTo({ scrollTop: this.frame.state.scrollTop, duration: 0 });
    },
    onPageScroll(e) {
      this.frame.state.scrollTop = e.scrollTop;
    },
    onHide() {
      this.visible = false;
      clearTimeout(this.successTimer);
      this.frame.state.filter = this.data.filter;
    },
    onUnload() {
      this.visible = false;
      clearTimeout(this.successTimer);
    },
    async onPullDownRefresh() {
      await this.run(() => this.load(true));
      wx.stopPullDownRefresh();
    },
    async run(fn) {
      if (this.data.busy) return;
      this.setData({ busy: true, error: "" });
      try {
        await fn();
      } catch (e) {
        this.setData({ error: e.message || "操作失败，请重试" });
      } finally {
        this.setData({ busy: false, loading: false });
      }
    },
    set(values) {
      this.setData(fmt.decorate(values));
    },
    async load(force = false) {
      const app = getApp();
      if (pageId === "01") {
        if (!wx.getStorageSync("explicitLogout") && app.globalData.cloudEnv) {
          const r = await api.call("auth.bootstrap");
          app.globalData.user = r.user;
          return nav.go(r.needsProfile ? "02" : "03", {}, { root: true });
        }
        return;
      }
      if (!app.globalData.user) {
        if (wx.getStorageSync("explicitLogout"))
          return nav.go("01", {}, { root: true });
        const r = await api.call("auth.bootstrap");
        app.globalData.user = r.user;
      }
      if (!app.globalData.user.profileComplete && pageId !== "02")
        return nav.go("02", {}, { root: true });
      const a = this.args;
      if (pageId === "02") {
        if (!this.initialized) {
          this.set({
            form: { displayName: app.globalData.user.displayName },
            user: app.globalData.user,
          });
          await this.loadAvatar(app.globalData.user);
          this.initialized = true;
        }
        return;
      }
      if (pageId === "03") {
        this.set({ home: await api.call("home.get") });
        await this.loadAvatar(app.globalData.user);
        return;
      }
      if (pageId === "03-A") {
        this.set(await api.call("project.list"));
        return;
      }
      if (pageId === "04") return;
      if (pageId === "05") {
        if (this.initialized && !force) return;
        const d = await api.call("project.draftOpen", {
          mode: a.projectId ? "EDIT" : "NEW",
          ...(a.projectId ? { projectId: a.projectId } : {}),
        });
        this.draft = d;
        this.set({
          form: d.fields,
          referenceInputs: d.referenceInputs,
          coverRevisionId: d.coverRevisionId,
          draft: d,
        });
        if (d.coverRevisionId) {
          const r = await api.call("file.getReadTicket", {
            target: {
              kind: "projectDraft",
              id: d.draftId,
              revisionId: d.coverRevisionId,
            },
          });
          this.setData({ coverUrl: r.downloadUrl });
        }
        const referenceNames = {};
        for (const ref of d.referenceInputs) {
          const r = await api.call("file.getReadTicket", {
            target: {
              kind: "projectDraft",
              id: d.draftId,
              revisionId: ref.revisionId,
            },
          });
          referenceNames[ref.revisionId] = r.name;
        }
        this.setData({ referenceNames });
        this.setDates(d.fields.dueAt);
        this.initialized = true;
        return;
      }
      if (["06", "07", "08"].includes(pageId)) {
        const project = await api.call("project.get", {
          projectId: a.projectId,
        });
        this.set({
          project,
          isLeader: project.myRole === "LEADER",
          remaining: Math.ceil((project.fields.dueAt - Date.now()) / 86400000),
        });
        if (["07", "08"].includes(pageId))
          this.set({
            references: (
              await api.call("reference.list", {
                projectId: a.projectId,
                pageSize: 3,
              })
            ).items,
          });
        if (pageId === "07")
          this.set({
            items: (
              await api.call("task.list", {
                projectId: a.projectId,
                filter: "ALL",
                pageSize: 5,
              })
            ).items,
          });
        if (project.coverRevisionId) {
          const ticket = await api.call("file.getReadTicket", {
            target: { kind: "cover", id: a.projectId },
          });
          this.setData({ coverUrl: ticket.downloadUrl });
        }
        return;
      }
      if (pageId === "09") {
        const project = await api.call("project.get", {
          projectId: a.projectId,
        });
        this.set({
          isLeader: project.myRole === "LEADER",
          ...(await api.call("reference.list", {
            projectId: a.projectId,
            ...(this.data.referenceCategory
              ? { category: this.data.referenceCategory }
              : {}),
          })),
        });
        return;
      }
      if (["10", "11", "15"].includes(pageId)) {
        const project = await api.call("project.get", {
          projectId: a.projectId,
        });
        if (pageId === "15" && project.myRole !== "LEADER")
          throw new Error("仅组长可访问");
        this.set({
          project,
          isLeader: project.myRole === "LEADER",
          ...(await api.call(pageId === "11" ? "task.listMine" : "task.list", {
            projectId: a.projectId,
            filter: this.data.filter,
          })),
        });
        if (pageId === "15")
          this.set({
            drafts: (
              await api.all("task.draftList", { projectId: a.projectId })
            ).items,
          });
        return;
      }
      if (["12", "13", "20"].includes(pageId)) {
        const task = await api.call("task.get", { taskId: a.taskId });
        this.args.projectId = task.projectId;
        if (
          pageId === "13" &&
          (!task.capabilities || !task.capabilities.canFirstUpload)
        )
          throw new Error("当前任务不能首次上传");
        if (
          pageId === "20" &&
          (!task.capabilities || !task.capabilities.canResubmit)
        )
          throw new Error("当前任务不能重新提交");
        this.set({ task });
        if (pageId === "12" && task.view === "FULL") {
          const project = await api.call("project.get", {
            projectId: task.projectId,
          });
          this.setData({
            leaderHistory: project.myRole === "LEADER",
            epochs: Array.from(
              { length: task.assignmentEpoch },
              (_, i) => "第" + (i + 1) + "轮分配",
            ),
            epochIndex: task.assignmentEpoch - 1,
          });
        }
        if (!this.initialized && task.draft) {
          this.set({ note: task.draft.note, mode: task.draft.mode });
          this.uploaded = { revisionId: task.draft.revisionId };
        }
        if (pageId === "20") {
          const versions = await api.all("version.list", { taskId: a.taskId });
          this.set({ versions: versions.items });
        }
        this.initialized = true;
        return;
      }
      if (pageId === "14") {
        if (this.initialized && !force) return;
        const project = await api.call("project.get", {
          projectId: a.projectId,
        });
        this.projectDueAt = project.fields.dueAt;
        if (project.myRole !== "LEADER") throw new Error("仅组长可管理任务");
        const members = (
          await api.all("member.list", { projectId: a.projectId })
        ).items;
        let form = {};
        if (a.taskId) {
          const t = await api.call("task.get", { taskId: a.taskId });
          this.originalTask = t;
          form = t.editDraft
            ? t.editDraft.fields
            : {
                title: t.title,
                description: t.description,
                requirements: t.requirements,
                assigneeId: t.assigneeId,
                dueAt: t.effectiveDueAt,
              };
          this.taskDraft = t.editDraft;
        } else if (a.draftTaskId) {
          this.taskDraft = (
            await api.all("task.draftList", { projectId: a.projectId })
          ).items.find((d) => d.draftTaskId === a.draftTaskId);
          if (this.taskDraft) form = this.taskDraft.fields;
        }
        this.set({
          editingTask: !!a.taskId,
          members,
          form,
          memberIndex: Math.max(
            0,
            members.findIndex((m) => m.userId === form.assigneeId),
          ),
        });
        this.setDates(form.dueAt);
        this.initialized = true;
        return;
      }
      if (pageId === "16") {
        this.set(
          await api.call("review.list", {
            projectId: a.projectId,
            filter: this.data.filter,
            ...(a.submissionId ? { submissionId: a.submissionId } : {}),
            ...(a.taskId ? { taskId: a.taskId } : {}),
          }),
        );
        return;
      }
      if (pageId === "17") {
        const ctx = await api.call("review.context", {
          submissionId: a.submissionId,
        });
        this.set({ reviewContext: ctx });
        return;
      }
      if (pageId === "18") {
        this.set(
          await api.call("notification.list", { category: this.data.filter }),
        );
        this.set({
          unread: (await api.call("notification.unreadCount")).count,
        });
        return;
      }
      if (pageId === "19") {
        const feedback = await api.call("review.get", { reviewId: a.reviewId });
        Object.assign(this.args, {
          projectId: feedback.projectId,
          taskId: feedback.taskId,
        });
        this.set({ feedback });
        return;
      }
      if (pageId === "02-A") {
        this.set({
          user: await api.call("user.get"),
          ...(await api.call("my.todoList", { tab: this.data.filter })),
        });
        await this.loadAvatar(this.data.user);
      }
    },
    markDirty() {
      this.dirty = true;
      if (wx.enableAlertBeforeUnload)
        wx.enableAlertBeforeUnload({ message: "离开将放弃尚未保存的修改" });
    },
    clean() {
      this.dirty = false;
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    },
    async loadAvatar(user) {
      if (user.avatarReadRef) {
        const r = await api.call("file.getReadTicket", {
          target: { kind: "avatar", id: user.userId },
        });
        this.setData({ avatarUrl: r.downloadUrl });
      }
    },
    setDates(n) {
      if (n) {
        const t = fmt.time(n);
        this.setData({ date: t.slice(0, 10), clock: t.slice(11, 16) });
      } else this.setData({ date: "", clock: "23:59" });
    },
    input(e) {
      const k = e.currentTarget.dataset.field;
      if (e.currentTarget.dataset.form)
        this.setData({ [`form.${k}`]: e.detail.value });
      else this.setData({ [k]: e.detail.value });
      if (pageId !== "09") this.markDirty();
    },
    pick(e) {
      this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
      if (pageId !== "09") this.markDirty();
    },
    historyEpoch(e) {
      this.setData({ epochIndex: Number(e.detail.value) });
      this.run(async () =>
        this.set({
          versions: (
            await api.all("version.list", {
              taskId: this.args.taskId,
              assignmentEpoch: Number(e.detail.value) + 1,
            })
          ).items,
        }),
      );
    },
    selectMode(e) {
      this.setData({ mode: e.detail.value });
      this.markDirty();
    },
    filter(e) {
      this.setData({ filter: e.currentTarget.dataset.value });
      this.run(() => this.load());
    },
    referenceFilter(e) {
      this.setData({ referenceCategory: e.currentTarget.dataset.value });
      this.run(() => this.load());
    },
    async back() {
      if (
        this.dirty &&
        !(await confirm("放弃未保存修改？", "已保存的草稿会保留。"))
      )
        return;
      this.clean();
      if (pageId === "07") return nav.go("03-A", {}, { root: true });
      if (pageId === "16")
        return nav.go("15", { projectId: this.args.projectId });
      if (pageId === "13") return nav.taskReturn(this.frame);
      nav.back(this.frame);
    },
    async go(e) {
      if (
        this.dirty &&
        !(await confirm("离开当前页面？", "未保存的修改不会发布。"))
      )
        return;
      this.clean();
      const d = e.currentTarget.dataset;
      const args = ["01", "02", "03", "03-A", "04", "18", "02-A"].includes(
        d.page,
      )
        ? {}
        : {
            ...(this.args.projectId ? { projectId: this.args.projectId } : {}),
            ...(["12", "13", "19", "20"].includes(d.page) && this.args.taskId
              ? { taskId: this.args.taskId }
              : {}),
          };
      if (d.task) args.taskId = d.task;
      if (d.project) args.projectId = d.project;
      if (d.review) args.reviewId = d.review;
      if (d.submission) args.submissionId = d.submission;
      if (d.draft) args.draftTaskId = d.draft;
      if (d.page === "14" && !d.task) delete args.taskId;
      nav.go(d.page, args);
    },
    async action(e) {
      const d = e.currentTarget.dataset;
      await this.run(() => this.perform(d.action, d));
    },
    async perform(action, d) {
      const a = this.args;
      if (action === "login") {
        await wx.login();
        wx.removeStorageSync("explicitLogout");
        const r = await api.call("auth.bootstrap");
        getApp().globalData.user = r.user;
        return nav.go(r.needsProfile ? "02" : "03", {}, { root: true });
      }
      if (action === "agreement" || action === "privacy")
        return wx.showModal({
          title:
            action === "agreement"
              ? "用户协议（内部试用）"
              : "隐私政策（内部试用）",
          content:
            action === "agreement"
              ? "本Demo用于小组协作内部试用。请仅上传您有权使用的资料；不提供在线Office编辑或即时聊天。正式上线前由运营者补充主体、联系方式和完整协议。"
              : "本Demo处理微信身份、昵称、可选头像、项目、文件和站内通知，用于成员识别、任务交付与审核。组长和本人可查看任务交付；覆盖前文件保留服务端审计。正式上线前由运营者明确保存期限、联系渠道和注销流程。",
          showCancel: false,
        });
      if (action === "logout") {
        wx.setStorageSync("explicitLogout", true);
        getApp().globalData.user = null;
        getApp().globalData.unread = 0;
        api.clear();
        return nav.go("01", {}, { root: true });
      }
      if (action === "saveProfile") {
        let avatarRevisionId;
        if (this.avatarFile) {
          const r = await files.upload(this.avatarFile, { purpose: "AVATAR" });
          avatarRevisionId = r.revisionId;
        }
        const user = await api.call("user.update", {
          displayName: this.data.form.displayName || "",
          expectedRevision: this.data.user.revision,
          ...(avatarRevisionId ? { avatarRevisionId } : {}),
        });
        getApp().globalData.user = user;
        this.clean();
        return nav.go("03", {}, { root: true });
      }
      if (action === "lookup") {
        this.set({
          preview: await api.call("invite.lookup", {
            code: (this.data.code || "").trim().toUpperCase(),
          }),
        });
        return;
      }
      if (action === "join") {
        const r = await api.call("project.join", {
          code: (this.data.code || "").trim().toUpperCase(),
        });
        this.clean();
        return nav.go("07", { projectId: r.projectId });
      }
      if (action === "resetInvite") {
        this.setData({ code: "", preview: null });
        this.clean();
        return;
      }
      if (action === "copy")
        return wx.setClipboardData({ data: this.data.project.inviteCode });
      if (action === "chooseCover") {
        const file = await files.choose(true);
        this.setData({ coverUrl: file.path });
        const r = await files.upload(
          file,
          { purpose: "PROJECT_COVER_DRAFT", draftKey: this.draft.draftKey },
          (p) => this.setData({ progress: p }),
        );
        this.setData({ coverRevisionId: r.revisionId });
        this.markDirty();
        return;
      }
      if (action === "chooseReference") {
        this.selectedReference = await files.choose();
        this.setData({ referenceName: this.selectedReference.name });
        // On the standalone reference page, choosing a file only selects a
        // local temporary file. It is not a project edit until create succeeds.
        if (pageId === "05") this.markDirty();
        return;
      }
      if (action === "attachReference") {
        if (!this.selectedReference) throw new Error("请先选择参考文件");
        const scope =
          pageId === "05"
            ? {
                purpose: "PROJECT_REFERENCE_DRAFT",
                draftKey: this.draft.draftKey,
              }
            : { purpose: "PROJECT_REFERENCE", projectId: a.projectId };
        const r = await files.upload(this.selectedReference, scope, (p) =>
          this.setData({ progress: p }),
        );
        const input = {
          revisionId: r.revisionId,
          category: categories[Number(this.data.categoryIndex)].value,
          description: this.data.referenceDescription || "",
        };
        if (pageId === "05")
          this.setData({
            referenceInputs: [...this.data.referenceInputs, input],
            [`referenceNames.${r.revisionId}`]: r.name,
          });
        else {
          await api.call("reference.create", {
            projectId: a.projectId,
            ...input,
          });
          await this.load();
          this.clean();
        }
        this.selectedReference = null;
        this.setData({ referenceName: "", referenceDescription: "" });
        return;
      }
      if (action === "removeDraftReference") {
        this.setData({
          referenceInputs: this.data.referenceInputs.filter(
            (_, i) => i !== Number(d.index),
          ),
        });
        this.markDirty();
        return;
      }
      if (action === "saveProjectDraft" || action === "publishProject") {
        let f = { timezone: "Asia/Shanghai" };
        for (const key of [
          "name",
          "description",
          "unifiedRequirements",
          "finalRequirements",
          "dueAt",
        ])
          if (this.data.form[key] !== undefined) f[key] = this.data.form[key];
        if (this.data.date)
          f.dueAt = fmt.parse(this.data.date, this.data.clock);
        this.draft = await api.call("project.draftSave", {
          mode: this.draft.mode,
          draftId: this.draft.draftId,
          fields: f,
          coverRevisionId: this.data.coverRevisionId || null,
          referenceInputs: this.data.referenceInputs,
          expectedDraftRevision: this.draft.draftRevision,
        });
        if (action === "saveProjectDraft") {
          this.clean();
          return nav.go("03", {}, { root: true });
        }
        if (a.projectId) {
          await api.call("project.update", {
            projectId: a.projectId,
            draftId: this.draft.draftId,
            expectedDraftRevision: this.draft.draftRevision,
            expectedRevision: this.draft.baseProjectRevision,
          });
          this.clean();
          return nav.go("08", { projectId: a.projectId });
        }
        const r = await api.call("project.publish", {
          draftId: this.draft.draftId,
          expectedDraftRevision: this.draft.draftRevision,
        });
        this.clean();
        return nav.go("06", { projectId: r.projectId });
      }
      if (action === "deleteReference") {
        if (
          !(await confirm(
            "删除参考文档？",
            "删除后成员无法继续读取，审计原件保留。",
          ))
        )
          return;
        await api.call("reference.delete", {
          projectId: a.projectId,
          referenceId: d.id,
          expectedRevision: Number(d.revision),
        });
        return this.load();
      }
      if (action === "preview" || action === "download") {
        let target = { kind: d.kind, id: d.id };
        if (d.revisionId) target.revisionId = d.revisionId;
        return files.open(target, action === "download", d.expected);
      }
      if (action === "chooseFile") {
        this.selectedFile = await files.choose();
        this.uploaded = null;
        this.setData({
          fileName: this.selectedFile.name,
          fileSize: this.selectedFile.size,
          progress: 0,
        });
        this.markDirty();
        return;
      }
      if (action === "saveSubmission" || action === "submit") {
        try {
          const task = this.data.task;
          if (this.selectedFile && !this.uploaded)
            this.uploaded = await files.upload(
              this.selectedFile,
              {
                purpose: "TASK_DRAFT",
                taskId: a.taskId,
                projectId: task.projectId,
              },
              (p) => this.setData({ progress: p }),
            );
          const draft = pageId === "12" ? task.draft : null;
          const revisionId = draft
            ? draft.revisionId
            : this.uploaded && this.uploaded.revisionId;
          if (!revisionId) throw new Error("请先选择并上传文件");
          const mode = draft
            ? draft.mode
            : pageId === "13"
              ? "FIRST"
              : this.data.mode;
          let base = {};
          if (mode !== "FIRST") {
            const v = draft
              ? null
              : this.data.versions.find(
                  (v) =>
                    v.visibleVersionId ===
                    task.currentSubmission.visibleVersionId,
                );
            base = {
              baseVersionId: draft ? draft.baseVersionId : v.visibleVersionId,
              expectedVersionRevision: draft
                ? draft.baseVersionRevision
                : v.versionRevision,
            };
          }
          const payload = {
            taskId: a.taskId,
            revisionId,
            mode,
            note: draft ? draft.note : this.data.note || "",
            expectedTaskRevision: task.revision,
            ...base,
          };
          await api.call(
            action === "submit" ? "submission.submit" : "submission.saveDraft",
            payload,
          );
          this.clean();
          if (pageId === "12") return this.load();
          if (action === "submit") {
            this.setData({ submissionSucceeded: true });
            wx.showToast({
              title: "提交成功，等待组长审核",
              icon: "none",
              duration: 2500,
            });
            this.successTimer = setTimeout(() => {
              if (this.visible) nav.taskReturn(this.frame);
            }, 2500);
          } else nav.taskReturn(this.frame);
        } catch (e) {
          if (action === "submit")
            wx.showToast({
              title: "提交失败，请检查网络或文件大小",
              icon: "none",
              duration: 2500,
            });
          throw e;
        }
        return;
      }
      if (action === "versions") {
        this.set({
          versions: (
            await api.all("version.list", {
              taskId: a.taskId,
              ...(this.data.leaderHistory
                ? { assignmentEpoch: Number(this.data.epochIndex) + 1 }
                : {}),
            })
          ).items,
          showVersions: !this.data.showVersions,
        });
        return;
      }
      if (action === "deleteTask") {
        if (
          !(await confirm(
            "删除任务？",
            "任务将退出公开列表，尚未审核的提交将撤销，原始证据保留。",
          ))
        )
          return;
        await api.call("task.delete", {
          taskId: a.taskId,
          expectedRevision: this.data.task.revision,
        });
        return nav.go("15", { projectId: a.projectId });
      }
      if (
        action === "saveTaskDraft" ||
        action === "publishTask" ||
        action === "publishContinue"
      ) {
        const form = {};
        for (const key of [
          "title",
          "description",
          "requirements",
          "assigneeId",
          "dueAt",
        ])
          if (this.data.form[key] !== undefined)
            form[key] = this.data.form[key];
        if (this.data.date)
          form.dueAt = fmt.parse(this.data.date, this.data.clock);
        if (form.dueAt > this.projectDueAt && action !== "saveTaskDraft")
          await wx.showModal({
            title: "截止时间提示",
            content: "任务DDL晚于项目总DDL，仍可继续保存。",
            showCancel: false,
          });
        const member = this.data.members[Number(this.data.memberIndex)];
        if (member) form.assigneeId = member.userId;
        const draft = this.taskDraft;
        if (action === "saveTaskDraft") {
          this.taskDraft = await api.call("task.draftSave", {
            mode: a.taskId ? "EDIT" : "NEW",
            projectId: a.projectId,
            fields: form,
            ...(a.taskId
              ? {
                  taskId: a.taskId,
                  expectedDraftRevision: draft ? draft.draftRevision : 0,
                }
              : {}),
            ...(draft
              ? {
                  draftTaskId: draft.draftTaskId,
                  expectedDraftRevision: draft.draftRevision,
                }
              : {}),
          });
        } else if (a.taskId) {
          const change = form.assigneeId !== this.originalTask.assigneeId;
          if (
            change &&
            !(await confirm(
              "更换负责人？",
              "将开启新分配轮次，旧待审撤销，新负责人从V1开始且不继承旧意见。",
            ))
          )
            return;
          await api.call("task.update", {
            taskId: a.taskId,
            fields: form,
            expectedRevision: this.originalTask.revision,
            ...(draft ? { expectedDraftRevision: draft.draftRevision } : {}),
            ...(change ? { confirmReassign: true } : {}),
          });
        } else
          await api.call("task.publish", {
            projectId: a.projectId,
            fields: form,
            ...(draft
              ? {
                  draftTaskId: draft.draftTaskId,
                  expectedDraftRevision: draft.draftRevision,
                }
              : {}),
          });
        this.clean();
        if (action === "publishContinue") {
          delete a.taskId;
          delete a.draftTaskId;
          this.taskDraft = null;
          this.originalTask = null;
          this.setData({ form: {}, date: "", clock: "23:59" });
          return;
        }
        return nav.go("15", { projectId: a.projectId });
      }
      if (action === "remind") {
        await api.call("task.remind", {
          taskId: d.id,
          expectedRevision: Number(d.revision),
        });
        return wx.showToast({ title: "已发送站内提醒", icon: "none" });
      }
      if (action === "approve") {
        if (
          !(await confirm("审核通过？", "将按此条提交的具体文件修订完成审核。"))
        )
          return;
        await api.call("review.approve", {
          submissionId: d.id,
          expectedTaskRevision: Number(d.revision),
        });
        return this.load();
      }
      if (action === "reject") {
        const ctx = this.data.reviewContext;
        if (!ctx.canReview) throw new Error("此提交已失效，请返回刷新");
        await api.call("review.reject", {
          submissionId: a.submissionId,
          expectedTaskRevision: ctx.expectedTaskRevision,
          reason: this.data.reason || "",
          revisionDueAt: this.data.date
            ? fmt.parse(this.data.date, this.data.clock)
            : null,
          priority: ["NORMAL", "IMPORTANT", "URGENT"][
            Number(this.data.priorityIndex)
          ],
        });
        this.clean();
        return nav.back(this.frame);
      }
      if (action === "readAll") {
        await api.call("notification.readAll", {
          watermark: this.data.watermark,
        });
        return this.load();
      }
      if (action === "notice") {
        const n = this.data.items.find((n) => n.notificationId === d.id);
        if (n.target.pageId === "12")
          await api.call("task.get", { taskId: n.taskId });
        else if (n.target.pageId === "19")
          await api.call("review.get", { reviewId: n.target.reviewId });
        else
          await api.call("review.context", {
            submissionId: n.target.submissionId,
          });
        await api.call("notification.read", {
          notificationId: n.notificationId,
        });
        const { pageId: target, ...args } = n.target;
        if (target === "16") {
          const ctx = await api.call("review.context", {
            submissionId: args.submissionId,
          });
          args.reviewFilter =
            ctx.submission.decision === "PENDING"
              ? "PENDING"
              : ctx.submission.decision === "APPROVED"
                ? "APPROVED"
                : "REJECTED";
        }
        return nav.go(target, args);
      }
      if (action === "acknowledge") {
        await api.call("notification.read", { reviewId: a.reviewId });
        return nav.back(this.frame);
      }
      if (action === "more") {
        const mapping = {
          "03-A": ["project.list", {}],
          "09": [
            "reference.list",
            {
              projectId: a.projectId,
              ...(this.data.referenceCategory
                ? { category: this.data.referenceCategory }
                : {}),
            },
          ],
          10: [
            "task.list",
            { projectId: a.projectId, filter: this.data.filter },
          ],
          11: [
            "task.listMine",
            { projectId: a.projectId, filter: this.data.filter },
          ],
          15: [
            "task.list",
            { projectId: a.projectId, filter: this.data.filter },
          ],
          16: [
            "review.list",
            {
              projectId: a.projectId,
              filter: this.data.filter,
              ...(a.taskId ? { taskId: a.taskId } : {}),
              ...(a.submissionId ? { submissionId: a.submissionId } : {}),
            },
          ],
          18: ["notification.list", { category: this.data.filter }],
          "02-A": ["my.todoList", { tab: this.data.filter }],
        };
        const [name, payload] = mapping[pageId];
        const r = await api.call(name, {
          ...payload,
          cursor: this.data.nextCursor,
        });
        this.set({ ...r, items: [...this.data.items, ...r.items] });
        return;
      }
      if (action === "retry") return this.load(true);
    },
    async avatar(e) {
      const path = e.detail.avatarUrl;
      const r = await wx.getFileInfo({ filePath: path });
      const info = await wx.getImageInfo({ src: path });
      const ext = info.type === "jpeg" ? "jpg" : info.type;
      if (!["jpg", "png"].includes(ext)) {
        this.setData({ error: "请选择 JPG 或 PNG 头像" });
        return;
      }
      this.avatarFile = {
        path,
        name: "avatar." + ext,
        size: r.size,
      };
      this.setData({ avatarUrl: path });
      this.markDirty();
    },
  };
}
module.exports = create;
