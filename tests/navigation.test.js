const test = require("node:test"),
  assert = require("node:assert/strict");
const nav = require("../miniprogram/services/navigation");
function harness() {
  const stack = [];
  global.getCurrentPages = () => stack;
  global.wx = {
    navigateTo({ url, success }) {
      push(url);
      if (success) success();
    },
    redirectTo({ url }) {
      stack.pop();
      push(url);
    },
    reLaunch({ url, success }) {
      stack.length = 0;
      push(url);
      if (success) success();
    },
    navigateBack({ delta }) {
      stack.splice(stack.length - delta, delta);
    },
  };
  function push(url) {
    const token = url.split("navToken=")[1];
    stack.push({ frame: nav.frames[token] });
  }
  const root = (id) => nav.go(id, {}, { root: true });
  return {
    stack,
    root,
    current: () => stack.at(-1).frame,
    ids: () => stack.map((p) => p.frame.pageId),
  };
}
for (const origin of ["02-A", "10", "11", "15", "18"])
  test(`task detail returns to ${origin} instance including filter`, () => {
    const h = harness();
    h.root(origin);
    const original = h.current();
    original.state.filter = "OVERDUE";
    nav.go("12", { taskId: "t1" });
    nav.back(h.current());
    assert.equal(h.current(), original);
    assert.equal(h.current().state.filter, "OVERDUE");
  });
test("12→19→12 preserves distinct instances and never creates a return cycle", () => {
  const h = harness();
  h.root("02-A");
  nav.go("12", { taskId: "t1" });
  const a = h.current();
  nav.go("19", { taskId: "t1", reviewId: "r1" });
  const b = h.current();
  nav.go("12", { taskId: "t1" });
  assert.notEqual(h.current(), a);
  nav.back(h.current());
  assert.equal(h.current(), b);
  nav.back(h.current());
  assert.equal(h.current(), a);
  nav.back(h.current());
  assert.equal(h.current().pageId, "02-A");
});
test("quick upload without detail anchor creates detail with original source", () => {
  const h = harness();
  h.root("11");
  nav.go("13", { taskId: "t1" });
  nav.taskReturn(h.current());
  assert.deepEqual(h.ids(), ["11", "12"]);
  nav.back(h.current());
  assert.equal(h.current().pageId, "11");
});
test("resubmit via feedback returns to original detail anchor", () => {
  const h = harness();
  h.root("02-A");
  nav.go("12", { taskId: "t1" });
  const original = h.current();
  nav.go("19", { taskId: "t1" });
  nav.go("20", { taskId: "t1" });
  nav.taskReturn(h.current());
  assert.equal(h.current(), original);
  nav.back(h.current());
  assert.equal(h.current().pageId, "02-A");
});
test("notification feedback quick resubmit cancel and success preserve different destinations", () => {
  const h = harness();
  h.root("18");
  nav.go("19", { taskId: "t1" });
  const feedback = h.current();
  nav.go("20", { taskId: "t1" });
  nav.back(h.current());
  assert.equal(h.current(), feedback);
  nav.go("20", { taskId: "t1" });
  nav.taskReturn(h.current());
  assert.equal(h.current().pageId, "12");
  nav.back(h.current());
  assert.equal(h.current(), feedback);
  nav.back(h.current());
  assert.equal(h.current().pageId, "18");
});
test("deep stack fallback redirects preserve ancestry frames", () => {
  const h = harness();
  h.root("02-A");
  const root = h.current();
  nav.go("12", { taskId: "t1" });
  const original = h.current();
  h.stack.splice(0, 1);
  nav.back(original);
  assert.equal(h.current(), root);
});
