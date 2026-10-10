const api = require("./api");
const allowed = [
  "doc",
  "docx",
  "ppt",
  "pptx",
  "xls",
  "xlsx",
  "pdf",
  "jpg",
  "jpeg",
  "png",
];
async function choose(image = false) {
  if (image) {
    const r = await wx.chooseMedia({ count: 1, mediaType: ["image"] });
    const f = r.tempFiles[0];
    const info = await wx.getImageInfo({ src: f.tempFilePath });
    const ext = info.type === "jpeg" ? "jpg" : info.type;
    if (!["jpg", "png"].includes(ext))
      throw new Error("请选择 JPG 或 PNG 图片");
    return {
      path: f.tempFilePath,
      name: `图片-${Date.now()}.${ext}`,
      size: f.size,
    };
  }
  const r = await wx.chooseMessageFile({
    count: 1,
    type: "file",
    extension: allowed,
  });
  const f = r.tempFiles[0];
  return { path: f.path, name: f.name, size: f.size };
}
async function upload(file, scope, onProgress) {
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error("请选择不超过20MiB的文件");
  const plan = await api.call("file.beginUpload", {
    ...scope,
    name: file.name,
    sizeHint: file.size,
  });
  const result = getApp().globalData.storageMode === 'selfhost'
    ? await require('./transport').upload(file, plan, onProgress)
    : await new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath: plan.tempPath,
      filePath: file.path,
      success: resolve,
      fail: reject,
    });
    task.onProgressUpdate((p) => onProgress && onProgress(p.progress));
  });
  return api.call("file.finalizeUpload", {
    uploadSessionId: plan.uploadSessionId,
    tempFileId: result.fileID,
  });
}
async function open(target, download = false, expectedRevisionId) {
  const r = await api.call("file.getReadTicket", {
    target,
    ...(expectedRevisionId ? { expectedRevisionId } : {}),
  });
  const f = r.localPath ? {statusCode:200,tempFilePath:r.localPath} : await wx.downloadFile({ url: r.downloadUrl });
  if (f.statusCode !== 200) throw new Error("下载失败");
  if (download) {
    const saved = r.localPath ? { savedFilePath: r.localPath } : await wx.saveFile({ tempFilePath: f.tempFilePath });
    if (wx.shareFileMessage) {
      try {
        await wx.shareFileMessage({
          filePath: saved.savedFilePath,
          fileName: r.name,
        });
        return saved;
      } catch (error) {
        // Some clients do not support direct file sharing. The download still exists.
      }
    }
    await wx.openDocument({
      filePath: saved.savedFilePath,
      fileType: r.name.split(".").pop().toLowerCase(),
      showMenu: true,
    });
    return saved;
  }
  if (/\.(png|jpg|jpeg)$/i.test(r.name))
    await wx.previewImage({ urls: [f.tempFilePath] });
  else
    await wx.openDocument({
      filePath: f.tempFilePath,
      fileType: r.name.split(".").pop().toLowerCase(),
      showMenu: true,
    });
}
module.exports = { choose, upload, open };
