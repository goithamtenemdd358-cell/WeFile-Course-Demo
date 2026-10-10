const names = {
  TODO: "待完成",
  DOING: "进行中",
  SUBMITTED: "待审核",
  CHANGES_REQUESTED: "需修改",
  DONE: "已完成",
  TASK_ASSIGNED: "新任务",
  FIRST_SUBMITTED: "文件首次提交",
  RESUBMITTED: "文件重新提交",
  APPROVED: "审核通过",
  MANUAL_REMINDER: "提醒提交",
  DUE_SOON: "DDL临近",
  OVERDUE: "逾期未交",
  ASSIGNMENT_CHANGED: "负责人调整",
};
function time(n) {
  if (!n) return "";
  return new Date(n + 8 * 3600000).toISOString().slice(0, 16).replace("T", " ");
}
function decorate(o) {
  if (!o || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(decorate);
  const r = {};
  Object.keys(o).forEach((k) => (r[k] = decorate(o[k])));
  if (o.state) r.stateText = names[o.state];
  if (o.eventType) r.eventText = names[o.eventType];
  [
    "dueAt",
    "effectiveDueAt",
    "createdAt",
    "submittedAt",
    "reviewedAt",
    "eventAt",
    "uploadedAt",
    "newDueAt",
    "originalSubmittedAt",
  ].forEach((k) => {
    if (o[k]) r[`${k}Text`] = time(o[k]);
  });
  return r;
}
function parse(date, clock) {
  const n = Date.parse(`${date}T${clock || "23:59"}:00+08:00`);
  if (!Number.isFinite(n)) throw new Error("请选择截止日期与时间");
  return n;
}
module.exports = { time, decorate, parse };
