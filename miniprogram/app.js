const config = require("./config");
App({
  globalData: { user: null, cloudEnv: config.cloudEnv, storageMode: config.storageMode, unread: 0 },
  onLaunch() {
    if (wx.cloud && config.cloudEnv)
      wx.cloud.init({ env: config.cloudEnv, traceUser: true });
  },
  onShow() {
    if (this.globalData.user)
      require("./services/api")
        .call("notification.unreadCount")
        .then((r) => {
          this.globalData.unread = r.count;
        })
        .catch(() => {});
  },
});
