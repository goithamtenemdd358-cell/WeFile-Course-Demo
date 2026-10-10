import fs from "node:fs";
for (const name of ["api", "reminders"]) {
  const base = `cloudfunctions/${name}`;
  fs.mkdirSync(`${base}/_shared`, { recursive: true });
  for (const f of fs.readdirSync("shared"))
    if (f.endsWith(".js"))
      fs.copyFileSync(`shared/${f}`, `${base}/_shared/${f}`);
  for (const f of ["contracts.schema.json", "api-contract.json"])
    fs.copyFileSync(`spec/${f}`, `${base}/_shared/${f}`);
  if (name === 'api' && fs.existsSync('artifacts/selfhost-cloud-config.json'))
    fs.copyFileSync('artifacts/selfhost-cloud-config.json',`${base}/_shared/relay-config.json`);
  fs.writeFileSync(
    `${base}/package.json`,
    JSON.stringify(
      {
        name: `wefile-${name}`,
        version: "1.0.0",
        main: "index.js",
        dependencies: { ajv: "8.17.1", "wx-server-sdk": "3.0.1" },
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(
  "Cloud functions packaged: api, reminders; independent shared sources copied.",
);
// Flat deployment copies work around DevTools 2.01 directory upload EISDIR.
// Canonical functions retain their independent _shared trees for IDE/manual use.
for (const name of ["api", "reminders"]) {
  const source = `cloudfunctions/${name}`;
  const target = `artifacts/deploy/${name}`;
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(`${source}/_shared`))
    fs.copyFileSync(`${source}/_shared/${file}`, `${target}/${file}`);
  for (const file of ["package.json", "package-lock.json"])
    fs.copyFileSync(`${source}/${file}`, `${target}/${file}`);
  fs.writeFileSync(`${target}/index.js`, fs.readFileSync(`${source}/index.js`, "utf8").replaceAll('./_shared/', './'));
  if (fs.existsSync(`${source}/config.json`)) fs.copyFileSync(`${source}/config.json`, `${target}/config.json`);
}
console.log("Flat CLI deployment copies ready in artifacts/deploy.");
