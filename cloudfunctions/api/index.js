"use strict";
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const { Service } = require("./_shared/service");
const { adapter, storage } = require("./_shared/cloud-adapter");
exports.main = async (event) => {
  const context = cloud.getWXContext();
  if (!context.OPENID || !context.APPID)
    return {
      ok: false,
      error: {
        code: "UNAUTHENTICATED",
        message: "请从微信小程序登录",
        retryable: false,
      },
      requestId: event.requestId || null,
      serverNow: Date.now(),
    };
  // SDK metadata is never an authentication source.
  const { userInfo: _ignoredSdkUserInfo, tcbContext: _ignoredTcbContext, ...request } = event;
  const fs = require('fs');
  const configPath = require('path').join(__dirname, './_shared/relay-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.enabled) return require('./_shared/relay').forward(config, `${context.APPID}:${context.OPENID}`, request);
  }
  const service = new Service(
    adapter(cloud.database({ throwOnNotFound: false })),storage(cloud),
    {secret:process.env.WATERMARK_SECRET,readOnly:process.env.WEFILE_READ_ONLY==='true',filesEnabled:process.env.WEFILE_FILES_ENABLED==='true'}
  );
  return service.invoke(`${context.APPID}:${context.OPENID}`, request);
};
