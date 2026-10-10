import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  routes = require("../miniprogram/services/navigation").routes;
const read = (f) => fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
const json = (f) => JSON.parse(read(f));
const app = json("miniprogram/app.json");
const actions =
  require("../cloudfunctions/api/_shared/service").implementedActions;
assert.deepEqual(
  [...actions].sort(),
  json("spec/api-contract.json")
    .map((a) => a.action)
    .sort(),
);
assert.equal(app.pages.length, 22);
assert.equal(new Set(app.pages).size, 22);
const pageSource = read("miniprogram/services/page.js");
let buttons = 0;
for (const route of app.pages) {
  for (const ext of ["js", "json", "wxml", "wxss"])
    assert.ok(fs.existsSync(`miniprogram/${route}.${ext}`));
  const template = read(`miniprogram/${route}.wxml`);
  assert.match(template, /<global-nav /);
  for (const match of template.matchAll(/data-page="([^"]+)"/g))
    assert.ok(routes[match[1]], `Unknown page ${match[1]}`);
  for (const match of template.matchAll(/data-action="([^"]+)"/g)) {
    assert.ok(
      pageSource.includes(`'${match[1]}'`) ||
        pageSource.includes(`"${match[1]}"`),
      `Missing handler ${match[1]}`,
    );
    buttons++;
  }
}
assert.equal(json("database/rules.json").read, false);
assert.equal(json("database/rules.json").write, false);
assert.equal(json("storage/rules.json").read, false);
assert.equal(json("cloudfunctions/invoke-rules.json").reminders.invoke, false);
assert.equal(json("cloudfunctions/invoke-rules.json")["*"].invoke, false);
for (const name of ["api", "reminders"]) {
  const root = `cloudfunctions/${name}`;
  assert.ok(
    fs.existsSync(`${root}/package-lock.json`),
    "Missing function lockfile",
  );
  const flat = `artifacts/deploy/${name}`;
  assert.equal(read(`${flat}/index.js`),read(`${root}/index.js`).replaceAll('./_shared/','./'));
  for (const f of fs.readdirSync(`${root}/_shared`)) assert.equal(read(`${flat}/${f}`),read(`${root}/_shared/${f}`));
  assert.deepEqual(json(`${flat}/package.json`),json(`${root}/package.json`));
  for (const file of fs.readdirSync("shared").filter((f) => f.endsWith(".js")))
    assert.equal(
      read(`shared/${file}`),
      read(`${root}/_shared/${file}`),
      `Stale cloud package ${name}/${file}`,
    );
  assert.deepEqual(
    json(`${root}/_shared/api-contract.json`),
    json("spec/api-contract.json"),
  );
}
function walk(d) {
  return fs
    .readdirSync(d, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
    );
}
for (const file of walk("miniprogram").filter((f) => f.endsWith(".js"))) {
  const src = read(file);
  assert.doesNotMatch(
    src,
    /MemoryDB|MemoryStorage|example\.invalid|test-adapter-only|wx\.cloud\.database\(/,
  );
  for (const m of src.matchAll(/require\(['"](\.[^'"]+)['"]\)/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    assert.ok(
      fs.existsSync(target) ||
        fs.existsSync(target + ".js") ||
        fs.existsSync(target + ".json"),
      `Missing module ${file}: ${m[1]}`,
    );
  }
}
assert.doesNotMatch(
  read("miniprogram/pages/messages/index.wxml"),
  /task\.state|item\.stateText/,
);
assert.doesNotMatch(read("miniprogram/pages/home/index.wxml"), /wx:for=/);
const appId = json("project.config.json").appid,
  config = require("../miniprogram/config");
const result = {
  at: new Date().toISOString(),
  status: "PASS",
  nativePages: 22,
  apiActions: json("spec/api-contract.json").length,
  actionBindings: buttons,
  functionPackages: 2,
  configuration: {
    appId:
      appId === "touristappid"
        ? "BLOCKED: effective AppID required"
        : "CONFIGURED",
    cloudEnv: config.cloudEnv
      ? "CONFIGURED"
      : "BLOCKED: authorized CloudBase environment required",
  },
  scope:
    "Package structure, routing, implementation bindings, private rules, deployable dependency boundaries; not real cloud acceptance",
};
fs.writeFileSync(
  "docs/PACKAGE_TEST_RESULT.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
