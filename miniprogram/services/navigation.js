const routes = {
  "01": "login",
  "02": "profile-edit",
  "03": "home",
  "03-A": "projects",
  "04": "join",
  "05": "project-edit",
  "06": "project-created",
  "07": "project-overview",
  "08": "project-info",
  "09": "references",
  10: "tasks-all",
  11: "tasks-mine",
  12: "task-detail",
  13: "submit-first",
  14: "task-edit",
  15: "leader-tasks",
  16: "reviews",
  17: "review-reject",
  18: "messages",
  19: "feedback",
  20: "resubmit",
  "02-A": "me",
};
const frames = {};
let sequence = 0;
function frame(pageId, args = {}, parent = null) {
  const f = {
    token: `n${++sequence}`,
    pageId,
    args: { ...args },
    parent: parent ? parent.token : null,
    state: {},
  };
  frames[f.token] = f;
  return f;
}
function url(f) {
  return `/pages/${routes[f.pageId]}/index?navToken=${f.token}`;
}
function current() {
  const ps = getCurrentPages();
  return ps.length ? ps[ps.length - 1].frame : null;
}
function go(pageId, args = {}, options = {}) {
  const parent = current();
  if (["03", "03-A", "02-A"].includes(pageId))
    options = { ...options, root: true };
  if (pageId === "15" && parent) {
    let at = parent;
    while (at) {
      if (at.pageId === "15" && at.args.projectId === args.projectId)
        return restore(at);
      at = frames[at.parent];
    }
  }

  const open = (f) =>
    wx.navigateTo({ url: url(f), fail: () => wx.redirectTo({ url: url(f) }) });
  if (options.root) {
    const f = frame(pageId, args);
    return wx.reLaunch({ url: url(f) });
  }
  // Create the required return anchor in the native stack, not just in metadata.
  if (pageId === "07" && (!parent || parent.pageId !== "03-A")) {
    const root = frame("03-A");
    const f = frame("07", args, root);
    return wx.reLaunch({ url: url(root), success: () => open(f) });
  }
  if (
    pageId === "16" &&
    (!parent ||
      parent.pageId !== "15" ||
      parent.args.projectId !== args.projectId)
  ) {
    const anchor = frame("15", { projectId: args.projectId }, parent),
      f = frame("16", args, anchor);
    return wx.navigateTo({
      url: url(anchor),
      success: () => open(f),
      fail: () => wx.redirectTo({ url: url(f) }),
    });
  }
  if (
    pageId === "13" &&
    (!parent || parent.pageId !== "12" || parent.args.taskId !== args.taskId)
  ) {
    const anchor = frame("12", args, parent),
      f = frame("13", args, anchor);
    return wx.navigateTo({
      url: url(anchor),
      success: () => open(f),
      fail: () => wx.redirectTo({ url: url(f) }),
    });
  }
  return open(frame(pageId, args, parent));
}
function restore(f) {
  if (!f) return go("03-A", {}, { root: true });
  const ps = getCurrentPages();
  const at = ps.findIndex((p) => p.frame && p.frame.token === f.token);
  if (at >= 0 && at < ps.length - 1)
    return wx.navigateBack({ delta: ps.length - 1 - at });
  if (at === ps.length - 1) return;
  return wx.redirectTo({ url: url(f) });
}
function back(f) {
  return restore(frames[f.parent]);
}
function taskReturn(f) {
  let parent = frames[f.parent];
  while (parent) {
    if (parent.pageId === "12" && parent.args.taskId === f.args.taskId)
      return restore(parent);
    parent = frames[parent.parent];
  }
  const source = frames[f.parent] || null;
  const target = frame(
    "12",
    { taskId: f.args.taskId, projectId: f.args.projectId },
    source,
  );
  return wx.redirectTo({ url: url(target) });
}
function bind(pageId, options) {
  return frames[options.navToken] || frame(pageId, {});
}
module.exports = {
  routes,
  frames,
  frame,
  url,
  go,
  restore,
  back,
  taskReturn,
  bind,
  current,
};
