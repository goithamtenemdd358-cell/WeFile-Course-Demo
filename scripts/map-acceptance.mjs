import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  routes = require("../miniprogram/services/navigation").routes;
const cases = JSON.parse(fs.readFileSync("spec/acceptance.json", "utf8"));
const records = cases.map((item) => {
  const ui = (item.requirements || []).find((r) => r.startsWith("UI-")),
    page = ui && ui.slice(3);
  let sources, tests;
  if (page && routes[page]) {
    sources = [
      `miniprogram/pages/${routes[page]}/index.wxml`,
      "miniprogram/services/page.js",
      "miniprogram/services/navigation.js",
    ];
    tests = [
      "tests/client.test.js",
      "tests/navigation.test.js",
      "docs/NATIVE_COMPILE_RESULT.json",
    ];
  } else if (/备份|恢复/.test(item.scenario) && item.id === "A50") {
    sources = [
      "scripts/backup.mjs",
      "scripts/verify-backup.mjs",
      "scripts/restore.mjs",
    ];
    tests = ["tests/extended.test.js"];
  } else if (item.id === "R08") {
    sources = [
      "scripts/validate-blueprint.py",
      "scripts/test-validator-mutations.py",
    ];
    tests = ["docs/BLUEPRINT_VALIDATION.json", "docs/VALIDATOR_MUTATIONS.json"];
  } else if (/容量|上传|封存|文件兼容/.test(item.scenario)) {
    sources = [
      "shared/uploads.js",
      "shared/maintenance.js",
      "shared/cloud-adapter.js",
    ];
    tests = [
      "tests/security.test.js",
      "tests/maintenance.test.js",
      "tests/extended.test.js",
    ];
  } else if (/来源|导航|页面底栏|返回|嵌套/.test(item.scenario)) {
    sources = [
      "miniprogram/services/navigation.js",
      "miniprogram/services/page.js",
      "miniprogram/components/global-nav/index.js",
    ];
    tests = ["tests/navigation.test.js", "tests/client.test.js"];
  } else if (/通知|已读|调度|提醒/.test(item.scenario)) {
    sources = [
      "shared/context.js",
      "shared/reads.js",
      "shared/service.js",
      "cloudfunctions/reminders/index.js",
    ];
    tests = [
      "tests/flow.test.js",
      "tests/security.test.js",
      "tests/extended.test.js",
    ];
  } else if (/统计|待办|进度|首页/.test(item.scenario)) {
    sources = ["shared/core.js", "shared/reads.js", "shared/projections.js"];
    tests = ["tests/security.test.js", "tests/flow.test.js"];
  } else {
    sources = [
      "shared/projects.js",
      "shared/tasks.js",
      "shared/submissions.js",
      "shared/projections.js",
      "shared/context.js",
      "miniprogram/services/page.js",
    ];
    tests = [
      "tests/flow.test.js",
      "tests/security.test.js",
      "tests/client.test.js",
    ];
  }
  return {
    id: item.id,
    scenario: item.scenario,
    requiredLevel: item.level,
    implementationPaths: sources,
    relatedLocalEvidence: tests,
    localCoverage: page
      ? "PARTIAL: controller loading, bindings and template compilation; not every native gesture automated"
      : "SEE_NAMED_SCENARIOS: related evidence is not a blanket pass for this acceptance item",
    realAcceptanceStatus:
      item.id === "R08"
        ? "SPEC_TOOL_ONLY_PASS"
        : /REAL_CLOUD|DEVTOOLS_AND_DEVICE/.test(item.level)
          ? "BLOCKED_ENVIRONMENT_OR_DEVICE"
          : "NOT_RUN_AS_SEPARATE_ACCEPTANCE",
    manualSteps: item.steps,
    expected: item.expected,
  };
});
fs.writeFileSync(
  "docs/ACCEPTANCE_IMPLEMENTATION.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      total: records.length,
      policy:
        "All original 216 items retained; source mappings and related local tests do not assert 216 acceptance passes. Real cloud/device evidence remains required.",
      records,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Mapped ${records.length} original acceptance items without changing spec.`,
);
