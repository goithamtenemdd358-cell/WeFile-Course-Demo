"use strict";
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const { Service } = require("./_shared/service");
const { adapter, storage } = require("./_shared/cloud-adapter");
exports.main = async (event, context) => {
  const wx = cloud.getWXContext();
  // Platform invoke=false is mandatory; event shape alone is never authorization.
  if (
    wx.OPENID ||
    wx.FROM_OPENID ||
    process.env.REMINDERS_PLATFORM_LOCKED !== "true" ||
    !context ||
    event.Type !== "Timer" ||
    event.TriggerName !== "wefile-hourly"
  )
    throw new Error("FORBIDDEN");
  return new Service(
    adapter(cloud.database({ throwOnNotFound: false })),
    storage(cloud),
    {
      secret: process.env.WATERMARK_SECRET,
      readOnly: process.env.WEFILE_READ_ONLY === "true",
    },
  ).reminders();
};
