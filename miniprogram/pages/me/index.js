const create = require("../../services/page");
const controller = create("02-A");
controller.onShareAppMessage = () => ({
  title: "WeFile 课程体验版",
  path: "/pages/login/index",
});
Page(controller);