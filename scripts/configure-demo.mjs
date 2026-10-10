import fs from "node:fs";
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.includes("="))
    .map((a) => {
      const at = a.indexOf("=");
      return [a.slice(2, at), a.slice(at + 1)];
    }),
);
if (!args.appid || !args.env) {
  console.log(
    "Usage: node scripts/configure-demo.mjs --appid=wx0123456789abcdef --env=your-authorized-test-env",
  );
  process.exit(1);
}
if (
  !/^wx[a-f0-9]{16}$/.test(args.appid) ||
  !/^[A-Za-z0-9_-]{3,100}$/.test(args.env)
)
  throw new Error("Invalid AppID or environment format");
const project = JSON.parse(fs.readFileSync("project.config.json", "utf8"));
project.appid = args.appid;
fs.writeFileSync(
  "project.config.json",
  JSON.stringify(project, null, 2) + "\n",
);
fs.writeFileSync(
  "miniprogram/config.js",
  "// Public environment identifier; never store secrets here.\nmodule.exports = " +
    JSON.stringify({ cloudEnv: args.env }, null, 2) +
    ";\n",
);
console.log(
  "Configured AppID and cloud environment. No resource created or deployed.",
);
