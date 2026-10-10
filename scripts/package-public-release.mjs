import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "artifacts", "public-release", "WeFile-Course-Demo-0.1");
const entries = [
  ".gitignore", "cloudbaserc.example.json", "package.json", "package-lock.json",
  "requirements-spec.txt", "project.config.json", "README.md", "miniprogram",
  "cloudfunctions", "database", "storage", "server", "shared", "spec", "tests", "scripts"
];
const blockedNames = new Set([".git", "node_modules", "artifacts", "backups", "server-data", "_shared", "__pycache__"]);
const blockedFiles = new Set(["config.local.js", "project.private.config.json", ".env"]);
function allowCopy(source) {
  const name = path.basename(source);
  return !blockedNames.has(name) && !blockedFiles.has(name) && !name.endsWith(".log") && !name.endsWith(".pyc");
}
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const entry of entries) {
  const source = path.join(root, entry);
  if (fs.existsSync(source)) fs.cpSync(source, path.join(destination, entry), { recursive: true, filter: allowCopy });
}
const projectPath = path.join(destination, "project.config.json");
const project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
project.appid = "touristappid";
project.projectname = "WeFile-Course-Demo";
project.description = "WeFile 课程公开源码；请替换为自己的 AppID 与云环境。";
fs.writeFileSync(projectPath, JSON.stringify(project, null, 2) + "\n");
fs.writeFileSync(
  path.join(destination, "miniprogram", "config.js"),
  "// Copy/configure for your own CloudBase environment. Never put secrets here.\nmodule.exports = { cloudEnv: '', storageMode: 'cloudbase' };\n",
);
fs.mkdirSync(path.join(destination, "config"), { recursive: true });
fs.writeFileSync(
  path.join(destination, "config", "selfhost-cloud-config.example.json"),
  JSON.stringify({ enabled: true, origin: "https://your-https-tunnel.example", bridgeSecret: "GENERATE_AND_STORE_PRIVATELY" }, null, 2) + "\n",
);
for (const name of ["COURSE_SUBMISSION.md", "DEMO_VIDEO_SCRIPT.md"]) {
  fs.copyFileSync(path.join(root, "docs", name), path.join(destination, name));
}
console.log(destination);

