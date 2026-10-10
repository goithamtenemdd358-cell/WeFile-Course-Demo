import cloudbase from "@cloudbase/node-sdk";
import fs from "node:fs";
export function admin() {
  const env = process.env.CLOUDBASE_ENV_ID;
  if (
    !env ||
    !process.env.TENCENTCLOUD_SECRETID ||
    !process.env.TENCENTCLOUD_SECRETKEY
  )
    throw new Error(
      "Set CLOUDBASE_ENV_ID / TENCENTCLOUD_SECRETID / TENCENTCLOUD_SECRETKEY in your terminal; never put credentials in source.",
    );
  const app = cloudbase.init({
    env,
    secretId: process.env.TENCENTCLOUD_SECRETID,
    secretKey: process.env.TENCENTCLOUD_SECRETKEY,
    ...(process.env.TENCENTCLOUD_SESSIONTOKEN
      ? { sessionToken: process.env.TENCENTCLOUD_SESSIONTOKEN }
      : {}),
  });
  return {
    app,
    env,
    db: adminAdapter(app.database()),
    storage: {
      async remove(fileID) {
        if (!fileID.startsWith(`cloud://${env}.`))
          throw new Error("Refusing cross-environment storage deletion");
        const result = await app.deleteFile({ fileList: [fileID] });
        if (
          result.fileList.some(
            (f) =>
              (f.code && f.code !== "SUCCESS") || (f.status && f.status !== 0),
          )
        )
          throw new Error("Storage deletion failed; quota retained");
      },
      fileIdForPath(path) {
        const prefix = process.env.CLOUDBASE_STORAGE_PREFIX;
        if (!prefix || !prefix.startsWith(`cloud://${env}.`))
          throw new Error(
            "Set verified CLOUDBASE_STORAGE_PREFIX for expired staging cleanup",
          );
        return `${prefix}/${path}`;
      },
    },
  };
}
export function adminAdapter(root) {
  function wrap(db, isTransaction = false) {
    return {
      async get(c, k) {
        const r = await db.collection(c).doc(k).get();
        return (Array.isArray(r.data) ? r.data[0] : r.data) || null;
      },
      async put(c, k, v) {
        const { _id, ...value } = v;
        await db.collection(c).doc(k).set(value);
      },
      async query(c, where) {
        if (isTransaction) throw new Error("No queries in a transaction");
        const all = [];
        let cursor = null;
        do {
          const query = {
            ...where,
            ...(cursor ? { _id: root.command.gt(cursor) } : {}),
          };
          const r = await root
            .collection(c)
            .where(query)
            .orderBy("_id", "asc")
            .limit(100)
            .get();
          all.push(...r.data);
          if (r.data.length < 100) break;
          cursor = r.data.at(-1)._id;
        } while (cursor);
        return all;
      },
      async transaction(fn) {
        let value;
        await root.runTransaction(async (tx) => {
          value = await fn(wrap(tx, true));
        });
        return value;
      },
    };
  }
  return wrap(root);
}
export const collections = JSON.parse(
  fs.readFileSync(
    new URL("../database/collections.json", import.meta.url),
    "utf8",
  ),
);
