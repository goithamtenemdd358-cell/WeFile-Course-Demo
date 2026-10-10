# WeFile 课程 Demo

WeFile 是一个原生微信小程序小组协作课程 Demo：项目成员通过邀请码加入项目，组长分配单负责人任务，负责人提交文件，组长审核并产生站内通知。项目使用 JavaScript、WXML、WXSS、CloudBase 云函数和私有文件访问规则；可选的课程体验模式把业务数据和文件保存在运行者自己的电脑上。

## 公开访问

- 源码：发布后在本仓库的 GitHub 首页访问。
- 可下载包：发布后在仓库的 **Releases** 下载 `WeFile-Course-Demo-0.1.zip`。
- 微信体验版：仅限管理员在微信小程序后台添加的体验成员，不能作为公开正式线上服务。

课程提交所需的已实现功能、测试边界、人工处理、AI 辅助及开源依赖说明见 [COURSE_SUBMISSION.md](COURSE_SUBMISSION.md)。三分钟演示视频的人工录制脚本见 [DEMO_VIDEO_SCRIPT.md](DEMO_VIDEO_SCRIPT.md)。

## 快速复现

```powershell
npm ci
# 在 project.config.json 填入自己的 AppID，
# 并在 miniprogram/config.js 填入自己的 CloudBase 环境 ID。
npm run build:cloud
npm run verify:local
npm run verify:package
node scripts/verify-native.mjs
```

之后用微信开发者工具导入项目目录，按 `database/`、`storage/rules.json` 和 `cloudbaserc.example.json` 配置自己的 CloudBase 资源并部署云函数。公开版不含任何真实 AppID、云环境、数据库、上传文件、备份、日志、隧道地址或密钥。

## 目录

- `miniprogram/`：22 个原生小程序页面和客户端服务。
- `shared/`：项目、任务、文件、提交、审核、通知和权限逻辑。
- `cloudfunctions/`：`api` 与 `reminders` 云函数；执行 `npm run build:cloud` 后生成内部共享文件。
- `server/`：可选的本机 SQLite/私有文件课程体验服务。
- `database/`、`storage/`：集合、索引和安全规则。
- `tests/`、`scripts/`：本地验证、打包和原生编译检查。

## 当前验证状态

本地应用测试于 2026-10-10 通过 68/68；工程打包检查与原生 WXML/WXSS 编译均已通过。真实微信身份桥的后续请求在最近一次回归中出现连接失败，因此当前不声称多人真机文件链路已稳定完成。详见 [COURSE_SUBMISSION.md](COURSE_SUBMISSION.md)。
