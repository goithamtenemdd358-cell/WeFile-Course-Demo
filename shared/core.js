"use strict";
const crypto = require("node:crypto");
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(Buffer.isBuffer(value) ? value : String(value))
    .digest("hex");
const id = (...parts) => hash(parts.join("|")).slice(0, 40);
const fresh = () => crypto.randomBytes(16).toString("hex");
class Fault extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}
function check(ok, code = "FORBIDDEN", message) {
  if (!ok) throw new Fault(code, message);
}
function cas(actual, expected) {
  check(actual === expected, "STALE_REVISION", "内容已更新，请刷新后重试");
}
const pending = (t) => ["TODO", "DOING", "CHANGES_REQUESTED"].includes(t.state);
const overdue = (t, now) => (pending(t) ? now > t.dueAt : !!t.submittedLate);
function stats(tasks, now) {
  const n = (s) => tasks.filter((t) => s.includes(t.state)).length;
  const completed = n(["DONE"]);
  return {
    total: tasks.length,
    completed,
    unfinished: tasks.length - completed,
    pending: n(["TODO", "DOING"]),
    awaitingReview: n(["SUBMITTED"]),
    changesRequested: n(["CHANGES_REQUESTED"]),
    overdue: tasks.filter((t) => overdue(t, now)).length,
    progress: tasks.length
      ? Math.round((completed * 10000) / tasks.length) / 100
      : 0,
  };
}
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, stable(v[k])]),
    );
  return v;
}
function page(rows, p, key = "_id") {
  const sorted = [...rows].sort((a, b) =>
    String(a[key]).localeCompare(String(b[key])),
  );
  let cursor = "";
  if (p.cursor) {
    try {
      cursor = Buffer.from(p.cursor, "base64url").toString();
    } catch {
      throw new Fault("INVALID_INPUT");
    }
  }
  const filtered = sorted.filter((x) => String(x[key]) > cursor);
  const items = filtered.slice(0, p.pageSize || 20);
  return {
    items,
    nextCursor:
      filtered.length > items.length
        ? Buffer.from(String(items.at(-1)[key])).toString("base64url")
        : null,
    total: rows.length,
  };
}
module.exports = {
  hash,
  id,
  fresh,
  Fault,
  check,
  cas,
  pending,
  overdue,
  stats,
  stable,
  page,
};
