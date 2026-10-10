import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const base =
  process.env.WECHAT_COMPILER_DIR ||
  "C:/Program Files (x86)/Tencent/微信web开发者工具/code/package.nw/node_modules/wcc-exec";
const root = path.resolve("miniprogram");
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
}
fs.mkdirSync("artifacts", { recursive: true });
const results = [];
for (const [exe, ext] of [
  ["wcc.exe", ".wxml"],
  ["wcsc.exe", ".wxss"],
]) {
  const file = path.join(base, exe);
  if (!fs.existsSync(file)) {
    results.push({
      compiler: exe,
      status: "BLOCKED",
      reason: "Set WECHAT_COMPILER_DIR to official compiler directory",
    });
    continue;
  }
  const sources = walk(root)
    .filter((f) => f.endsWith(ext))
    .map((f) => path.relative(root, f).replaceAll("\\", "/"));
  const out = path.resolve(`artifacts/native-${ext.slice(1)}.js`);
  const r = spawnSync(file, ["-o", out, ...sources], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  results.push({
    compiler: exe,
    files: sources.length,
    status: r.status === 0 ? "PASS" : "FAIL",
    exitCode: r.status,
    output: r.stderr || r.stdout || "",
  });
}
fs.writeFileSync(
  "docs/NATIVE_COMPILE_RESULT.json",
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scope:
        "Official WXML/WXSS compiler only; simulator/cloud/device not implied",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify(results, null, 2));
if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
