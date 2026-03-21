# 原生微信小程序（与当前 H5 + Node 后端配合）

## 为什么选「原生」而不是 web-view？

| 维度 | 原生小程序 | web-view 嵌 H5 |
|------|------------|----------------|
| 体验 | 启动快、手势/路由符合微信规范 | 依赖内置浏览器，部分机型偏慢 |
| 能力 | `wx.chooseMedia`、订阅消息、分享等一等公民 | 能力受限或要桥接 |
| 审核 | 类目与权限清晰 | 个人主体等对 web-view 限制更多（以平台为准） |
| 成本 | 要重做 UI（WXML/WXSS），但接口可复用 | 改最少，但长期维护两套渲染 |

**结论**：你已决定原生，则后端 **几乎不用重写**；主要工作是把 `index.tsx` 里的界面与状态迁到各 `pages/*`，网络层已与 H5 `api.ts` 对齐。

## 本仓库里的工程在哪？

目录：`miniprogram/`

- 用 **微信开发者工具** → 导入项目 → 选择 **`miniprogram` 文件夹**（内含 `app.json`、`project.config.json`）。
- 在 `project.config.json` 里把 `appid` 改成你的小程序 AppID。

## 你必须完成的配置

### 1. `utils/config.js` 里的 `API_BASE`

填成线上 **HTTPS** 地址，且必须以 `/api` 结尾（与 Express 路由一致），例如：

- `https://api.你的域名.com/api`
- 或 `https://你的域名.com/api`

**原因**：小程序禁止随意请求域名；且 `wx.request` 在真机上只认已在公众平台配置的 **request 合法域名**。

### 2. 微信公众平台

- **开发 → 开发管理 → 开发设置 → 服务器域名**：添加与 `API_BASE` 一致的 **https 根域名**（不要带路径）。
- 开发阶段可在开发者工具勾选 **「不校验合法域名、web-view、TLS 版本」** 联调；**真机预览必须配置正确域名 + 有效证书**。

### 3. Tab 图标

`assets/tab/*.png` 当前为 **1×1 占位图**。上线前请替换为 **81×81 px** 左右的 PNG（选中和未选中各一套）。

## 页面与 H5 对照（迁移清单）

| 小程序页面 | 对应 H5（index.tsx） | 当前骨架状态 |
|------------|----------------------|--------------|
| `pages/home/home` | Tab「数据」、环形进度、饮水、进食列表 | 占位说明 |
| `pages/plan/plan` | Tab「方案」、食堂场景、`aiPlan`、换一批 | 已接 `aiPlan` 试调用 |
| `pages/scan/scan` | Tab「扫码」、`chooseMedia` + `aiScan` | 已接选图 + 识别 |
| `pages/coach/coach` | Tab「AI专家」、`aiChat` | 已接简单输入框 |
| `pages/profile/profile` | Tab「档案」、问卷、`wx_user_profile` | 占位 + 清缓存 |

本地存储键名见 `utils/storage.js`，与 H5 `LocalDB` 保持一致，便于以后做数据同步或灰度迁移。

## 后端部署（与 H5 共用）

同一套 `server/index.js`：部署到云主机 + 备案域名 + HTTPS，环境变量（`DOUBAO_API_KEY`、Supabase 等）只放在服务器。

## 提交审核前建议

- 隐私政策与用户协议（若收集健康相关信息）。
- 文案避免「诊疗」「治愈」等医疗承诺；保持与 README 一致的免责声明。
- 在「用户隐私保护指引」中声明相机/相册用途（拍照识别食物）。

## 可选：TypeScript

若希望小程序也用 TS，可在微信开发者工具中开启 **TS 编译**，并将 `*.js` 逐步改为 `*.ts`；当前骨架使用 **CommonJS `require`**，与默认模板一致，便于先跑通流程。
