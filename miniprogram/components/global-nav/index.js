const nav = require("../../services/navigation");
Component({
  properties: { active: String },
  data: {
    unread: 0,
    tabs: [
      { id: "03", label: "首页" },
      { id: "03-A", label: "项目" },
      { id: "18", label: "消息" },
      { id: "02-A", label: "我的" },
    ],
  },
  pageLifetimes: {
    show() {
      this.setData({ unread: getApp().globalData.unread });
      if (getApp().globalData.user)
        require("../../services/api")
          .call("notification.unreadCount")
          .then((r) => {
            getApp().globalData.unread = r.count;
            this.setData({ unread: r.count });
          })
          .catch(() => {});
    },
  },
  methods: {
    async choose(e) {
      const pages = getCurrentPages(),
        page = pages[pages.length - 1];
      if (page && page.dirty) {
        const r = await wx.showModal({
          title: "离开当前页面？",
          content: "未保存的修改不会发布，已保存草稿仍保留。",
        });
        if (!r.confirm) return;
        if (page.clean) page.clean();
      }
      let id = e.currentTarget.dataset.id;
      const user = getApp().globalData.user;
      if (!user) id = "01";
      else if (!user.profileComplete) id = "02";
      nav.go(id, {}, { root: true });
    },
  },
});
