const writes = new Set([
  "user.update",
  "project.draftOpen",
  "project.draftSave",
  "project.publish",
  "project.update",
  "project.join",
  "reference.create",
  "reference.delete",
  "task.draftSave",
  "task.publish",
  "task.update",
  "task.delete",
  "task.remind",
  "file.beginUpload",
  "file.finalizeUpload",
  "submission.saveDraft",
  "submission.submit",
  "review.approve",
  "review.reject",
  "notification.read",
  "notification.readAll",
]);
const pending = new Map();
function requestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
async function call(action, payload = {}) {
  if (!getApp().globalData.cloudEnv)
    throw new Error("尚未配置 CloudBase 环境，请按部署说明填写 config.js");
  const fingerprint =
    (getApp().globalData.user ? getApp().globalData.user.userId : "login") +
    "|" +
    action +
    JSON.stringify(payload);
  const persisted = wx.getStorageSync("wefile.pendingOperations") || [];
  for (const pair of persisted) pending.set(pair[0], pair[1]);
  let rid = pending.get(fingerprint);
  if (writes.has(action) && !rid) {
    rid = requestId();
    pending.set(fingerprint, rid);
    wx.setStorageSync(
      "wefile.pendingOperations",
      Array.from(pending.entries()),
    );
  }
  const data = { action, payload };
  if (rid) data.requestId = rid;
  let response;
  try {
    response = await wx.cloud.callFunction({ name: "api", data });
  } catch (error) {
    const detail = String((error && (error.errMsg || error.message)) || "");
    if ((error && Number(error.errCode) === -504003) || /timed out|time limit/i.test(detail))
      throw new Error("服务连接超时。请让项目组织者确认电脑没有休眠，并已运行 Start-WeFile.cmd；稍后点击刷新重试。");
    throw error;
  }
  const r = response.result;
  if (!r || !r.ok) {
    const e = new Error(r && r.error ? r.error.message : "云函数返回异常");
    e.code = r && r.error && r.error.code;
    if (r && r.error && !r.error.retryable) {
      pending.delete(fingerprint);
      wx.setStorageSync(
        "wefile.pendingOperations",
        Array.from(pending.entries()),
      );
    }
    throw e;
  }
  pending.delete(fingerprint);
  wx.setStorageSync("wefile.pendingOperations", Array.from(pending.entries()));
  if (action === 'file.getReadTicket' && getApp().globalData.storageMode === 'selfhost') {
    const localPath = await require('./transport').download(r.data);
    return {...r.data, localPath, downloadUrl:localPath};
  }
  return r.data;
}
async function all(action, payload = {}) {
  let cursor,
    result,
    items = [];
  do {
    result = await call(action, {
      ...payload,
      pageSize: 50,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return { ...result, items, nextCursor: null };
}
module.exports = {
  call,
  all,
  clear: () => {
    if (getApp().globalData.storageMode === 'selfhost') {try {require('./transport').clear();} catch(e) {}}
    pending.clear();
    wx.removeStorageSync("wefile.pendingOperations");
  },
};
