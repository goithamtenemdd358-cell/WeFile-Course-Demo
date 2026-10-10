"use strict";
const https = require("node:https");
const { check, Fault } = require("./core");
function adapter(db, root = db, transactional = false) {
  let operations = 0;
  const tick = () =>
    check(!transactional || ++operations <= 95, "TRANSACTION_BUDGET_EXCEEDED");
  return {
    async get(collection, key) {
      tick();
      try {
        const r = await db.collection(collection).doc(key).get();
        return (Array.isArray(r.data) ? r.data[0] : r.data) || null;
      } catch (e) {
        if (
          (e.errCode === -1 &&
            /not exist|不存在/i.test(e.errMsg || e.message)) ||
          e.errCode === -502005
        )
          return null;
        throw e;
      }
    },
    async put(collection, key, value) {
      tick();
      const { _id, ...data } = value;
      await db.collection(collection).doc(key).set({ data });
    },
    async query(collection, where) {
      check(!transactional, "INTERNAL_ERROR", "事务内禁止集合扫描");
      const out = [];
      let last = null;
      while (true) {
        const q = { ...where };
        if (last) q._id = root.command.gt(last);
        const result = await db
          .collection(collection)
          .where(q)
          .orderBy("_id", "asc")
          .limit(100)
          .get();
        out.push(...result.data);
        if (result.data.length < 100) break;
        last = result.data.at(-1)._id;
      }
      return out;
    },
    async transaction(fn) {
      let value;
      await root.runTransaction(async (tx) => {
        value = await fn(adapter(tx, root, true));
      });
      return value;
    },
  };
}
function boundedDownload(url, max) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    check(u.protocol === "https:", "STORAGE_ERROR");
    const request = https.get(u, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Fault("STORAGE_ERROR"));
        return;
      }
      if (Number(response.headers["content-length"]) > max) {
        response.destroy();
        reject(new Fault("FILE_TOO_LARGE"));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > max) {
          response.destroy();
          reject(new Fault("FILE_TOO_LARGE"));
        } else chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.setTimeout(20000, () =>
      request.destroy(new Fault("STORAGE_ERROR")),
    );
    request.on("error", reject);
  });
}
function storage(cloud) {
  return {
    async ticket(fileID) {
      const r = await cloud.getTempFileURL({
        fileList: [{ fileID, maxAge: 300 }],
      });
      const f = r.fileList[0];
      check(f && f.status === 0 && f.tempFileURL, "STORAGE_ERROR");
      return { url: f.tempFileURL, expiresAt: Date.now() + 300000 };
    },
    async readTemporary(fileID, path, max) {
      check(
        typeof fileID === "string" && fileID.startsWith("cloud://"),
        "INVALID_INPUT",
      );
      const slash = fileID.indexOf("/", 8);
      check(slash >= 0 && fileID.slice(slash + 1) === path, "FORBIDDEN");
      const env =
        cloud.getWXContext().ENV ||
        process.env.TCB_ENV ||
        process.env.SCF_NAMESPACE;
      check(env && fileID.slice(8, slash).startsWith(`${env}.`), "FORBIDDEN");
      const ticket = await this.ticket(fileID);
      return boundedDownload(ticket.url, max);
    },
    async seal(cloudPath, bytes) {
      const r = await cloud.uploadFile({ cloudPath, fileContent: bytes });
      check(r.fileID, "STORAGE_ERROR");
      return r.fileID;
    },
  };
}
module.exports = { adapter, storage };
