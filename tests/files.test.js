const test = require("node:test");
const assert = require("node:assert/strict");
function loadFiles(t, { storageMode, shareFails = false }) {
  const previousWx = global.wx, previousApp = global.getApp;
  const filesPath = require.resolve("../miniprogram/services/files"), apiPath = require.resolve("../miniprogram/services/api"), transportPath = require.resolve("../miniprogram/services/transport");
  const opened = [], shared = [], saved = [], storage = {};
  delete require.cache[filesPath]; delete require.cache[apiPath]; delete require.cache[transportPath];
  global.getApp = () => ({ globalData: { cloudEnv: "test", storageMode, user: { userId: "user" } } });
  global.wx = {
    getStorageSync: (key) => storage[key],
    setStorageSync: (key, value) => (storage[key] = value),
    removeStorageSync: (key) => delete storage[key],
    cloud: { callFunction: async () => ({ result: { ok: true, data: { name: "交付.pdf", downloadUrl: "https://example.invalid/file" } } }) },
    downloadFile: async () => ({ statusCode: 200, tempFilePath: "/tmp/download.pdf" }),
    saveFile: async ({ tempFilePath }) => { saved.push(tempFilePath); return { savedFilePath: "/saved/download.pdf" }; },
    shareFileMessage: async (options) => { shared.push(options); if (shareFails) throw Error("unsupported"); },
    openDocument: async (options) => opened.push(options),
  };
  if (storageMode === "selfhost") require.cache[transportPath] = { id: transportPath, filename: transportPath, loaded: true, exports: { download: async () => "/local/download.pdf" } };
  t.after(() => { global.wx = previousWx; global.getApp = previousApp; delete require.cache[filesPath]; delete require.cache[apiPath]; delete require.cache[transportPath]; });
  return { files: require("../miniprogram/services/files"), opened, shared, saved };
}
test("download falls back to a save-menu document when direct sharing is unavailable", async (t) => {
  const x = loadFiles(t, { storageMode: "selfhost", shareFails: true });
  const saved = await x.files.open({ kind: "reference", id: "file" }, true);
  assert.equal(saved.savedFilePath, "/local/download.pdf");
  assert.equal(x.shared.length, 1);
  assert.deepEqual(x.opened, [{ filePath: "/local/download.pdf", fileType: "pdf", showMenu: true }]);
});
test("download keeps the regular saved-file share flow when sharing works", async (t) => {
  const x = loadFiles(t, { storageMode: "cloud" });
  const saved = await x.files.open({ kind: "reference", id: "file" }, true);
  assert.equal(saved.savedFilePath, "/saved/download.pdf");
  assert.deepEqual(x.saved, ["/tmp/download.pdf"]);
  assert.deepEqual(x.shared, [{ filePath: "/saved/download.pdf", fileName: "交付.pdf" }]);
  assert.equal(x.opened.length, 0);
});