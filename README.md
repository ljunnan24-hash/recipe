# Recipe — 私人 AI 营养专家

> 通过拍照识别、智能配餐与实时咨询，助您科学达成健康目标。

[![React](https://img.shields.io/badge/React-19.0-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.2-646cff?logo=vite)](https://vitejs.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-4.2-38bdf8?logo=tailwindcss)](https://tailwindcss.com/)
[![豆包](https://img.shields.io/badge/AI-豆包%20火山方舟-6366f1)](https://www.volcengine.com/product/doubao)

---

## 目录

- [功能概览](#功能概览)
- [技术架构](#技术架构)
- [项目结构](#项目结构)
- [环境要求与运行](#环境要求与运行)
- [环境变量](#环境变量)
- [脚本说明](#脚本说明)
- [数据与隐私](#数据与隐私)
- [版本与许可](#版本与许可)

---

## 功能概览

| 模块 | 说明 |
|------|------|
| **数据（首页）** | 今日热量/蛋白质/碳水/脂肪环形进度、饮水量记录、进食明细列表，支持删除单条记录 |
| **方案** | 选择「均衡家常」或「深大南区食堂」场景，由 AI 生成一日三餐配餐方案（含名称、热量、描述与配图） |
| **扫码** | 拍摄/上传食物图片，由豆包识别营养成分（名称、热量、蛋白质等），选择餐次后记入饮食日志 |
| **AI 专家** | 基于用户档案的 Markdown 对话，提供营养建议与答疑（免责声明：仅供参考，非医疗诊断） |
| **档案** | 查看/编辑体重、身高、近期目标；重新评估身体状态（引导流程）；隐私与合规说明；清空本地数据 |

**新用户引导（Onboarding）**：多步骤问卷（基础信息 → 健身核心 → 身体与代谢 → 饮食与偏好 → 控量关键 → AI 分析预览），完成后数据持久化到本地并进入主界面。

---

## 技术架构

- **前端**：React 19 + TypeScript，单页应用，底部 Tab 导航（5 个入口）；通过 `api.ts` 请求后端 `/api`，不持有任何 API Key
- **后端**：Node.js + Express（`server/index.js`），提供 `/api/ai/scan`、`/api/ai/plan`、`/api/ai/chat`、`/api/ai/report` 等，在服务端调用豆包（火山方舟），**DOUBAO_API_KEY 仅存在于服务端环境变量**
- **构建与开发**：Vite 6，开发时将 `/api` 代理到后端（前端 4300 → 后端 4301），支持 HMR、路径别名 `@/`
- **样式**：Tailwind CSS 4（`@tailwindcss/vite`），自定义主题色 `#07c160`（微信绿）、安全区与无滚动条工具类
- **动效**：Framer Motion（页面切换、Toast、进度条动画）时，所有 AI 接口返回 503，前端会提示失败
- **AI**：豆包（火山方舟 Responses API）在后端调用，用于食物识别、配餐生成、聊天；模型由 `DOUBAO_MODEL` / `DOUBAO_VISION_MODEL` 配置
- **数据持久化**：
  - 未登录用户：浏览器 `localStorage`（用户档案、每日摄入、饮水等，仅存本机）
  - 登录用户（邮箱魔法链接）：Supabase（见下文「Supabase 表说明」）中持久化档案、每日记录、健康报告与最后一次保存的方案
  - **深大食堂菜品**：存于 Supabase（`canteen_dishes` / `restaurant_menu` 表），方案页选择「深大南区」时后端从数据库拉取真实菜品与热量，供 AI 做针对性推荐
- **配图**：方案页使用 Pollinations.ai 根据餐名生成示例图片（非存储式，仅展示）

---

## 项目结构

```
recipe/
├── index.html          # 入口 HTML，lang=zh-CN，viewport/安全区/importmap
├── index.tsx           # 应用入口与全部 UI 逻辑（单文件架构）
├── index.css           # 全局样式、Tailwind 入口、@theme、safe-area/no-scrollbar
├── api.ts              # 前端 API 封装：aiScan / aiPlan / aiChat / aiHealthReport，请求 /api 代理到后端
├── supabaseClient.ts   # 前端 Supabase 客户端（邮箱登录、云端档案/日志同步）
├── vite.config.ts      # Vite 配置：React、Tailwind、端口 4300、/api 代理到 4301，envPrefix
├── tsconfig.json       # TypeScript：ES2022、JSX、paths @/*
├── package.json        # 依赖与脚本（含 server、dev:all）
├── .env.local          # 本地环境变量（含 DOUBAO_API_KEY 等，仅后端读取，不提交）
├── .gitignore
├── metadata.json       # 应用元信息（名称、描述、权限如 camera）
├── server/
│   ├── index.js        # 后端服务：/api/health、/api/ai/*、/api/canteen/dishes、/api/ai/report，集成 Supabase
│   └── supabase/
│       └── schema.sql  # Supabase 建表与示例数据（canteen_dishes）
├── miniprogram/        # 微信原生小程序（WXML/WXSS），与同一 Node 后端联调；说明见 docs/MINIPROGRAM_NATIVE.md
├── docs/
│   ├── DEPLOY.md                       # 生产部署、Nginx、备案与上线顺序（含 Supabase 配置与 SQL）
│   ├── MINIPROGRAM_NATIVE.md
│   ├── supabase-user-profiles.sql      # Supabase 用户档案表 user_profiles
│   ├── supabase-saved-meal-plan.sql    # Supabase 方案表 user_saved_meal_plan
│   └── supabase-daily-logs-and-report.sql # Supabase 日志与健康报告表 user_daily_log / user_health_report
├── .env.example        # 服务端环境变量示例（复制为 .env / .env.local，勿提交密钥）
└── README.md           # 本文件
```

前端：类型定义、`LocalDB`、通用组件、主应用 `App`、Tab 与弹窗、子组件（EditField、TabItem）均在 `index.tsx`。后端：Express 单文件，依赖 `@google/genai`、`express`、`dotenv`。

---

## 环境要求与运行

- **Node.js**：建议 18+（支持 ESM、Vite 6）
- **包管理**：npm / pnpm / yarn 均可

**AI 功能依赖后端服务**：前端通过 `/api` 请求后端，后端再调用 **豆包（火山方舟）**；未启动后端时，扫码、方案生成、AI 专家会报错。

```bash
# 安装依赖
npm install

# 开发：同时启动后端（4301）与前端（4300），前端将 /api 代理到后端
npm run dev:all

# 或分开启动：先开一个终端运行后端，再开一个运行前端
npm run server    # 后端 http://localhost:4301
npm run dev       # 前端 http://localhost:4300

# 生产构建（同域 Nginx 反代 /api 时无需 VITE_API_BASE）
npm run build

# 预览生产构建（需另行运行后端；跨域 API 见 .env.production 中 VITE_API_BASE）
npm run preview
```

---

## 环境变量

在项目根目录创建 `.env.local` 或 `.env`（已加入 .gitignore），供**后端**读取。完整项见 **`.env.example`**。

```env
SERVER_PORT=4301

# 豆包（火山方舟）
DOUBAO_API_KEY=你的_豆包_API_Key
DOUBAO_MODEL=doubao-seed-2-0-mini-260215

# Supabase（深大食堂菜单 + 登录用户云端档案/日志）
SUPABASE_URL=你的_Supabase_URL
SUPABASE_ANON_KEY=你的_Supabase_anon_key

# 服务器正式环境建议增加：NODE_ENV=production

# 可选：前端构建专用变量（若不想在构建环境额外注入 SUPABASE_*）
VITE_SUPABASE_URL=你的_Supabase_URL
VITE_SUPABASE_ANON_KEY=你的_Supabase_anon_key
```

- `DOUBAO_API_KEY`：后端调用豆包 responses API 时使用，**不会出现在前端代码或构建产物中**。
- `DOUBAO_MODEL`：豆包模型名称，示例为 `doubao-seed-2-0-mini-260215`，可按实际需要替换。
- `DOUBAO_VISION_MODEL`：可选，**拍照识别**使用的模型，须为支持图像输入的模型（如豆包视觉模型）。不填则与 `DOUBAO_MODEL` 相同；若当前模型不支持识图，请在火山方舟控制台查看支持「图片理解」的模型 ID 并填在此处。
- `SERVER_PORT`：可选，后端监听端口，默认 **4301**（与 `vite.config.ts` 代理一致）。

**生产部署**（腾讯云 Nginx、PM2、备案与小程序域名）：见 **[docs/DEPLOY.md](./docs/DEPLOY.md)**。
- `SUPABASE_URL`：Supabase 项目 URL（Project Settings → API → Project URL）。
- `SUPABASE_ANON_KEY`：Supabase 匿名密钥（Project Settings → API → anon public）。未配置时登录、云端档案与日志不可用，「深大南区」方案也无法从数据库拉取真实菜品。

未配置 `DOUBAO_API_KEY` 时，后端会返回 503，前端 Toast 提示失败。

### Supabase 表说明

1. **菜品与营养成分**
   - `canteen_dishes` / `restaurant_menu`：深大食堂菜单与营养数据，方案页选择「深大南区」时从这里拉真实菜谱。
   - `food_nutrition_authority`：权威营养成分表（按菜名精算拍照识别结果）。
2. **用户登录与档案**
   - 登录邮箱：内置表 `auth.users`（Supabase Authentication → Users）。
   - `user_profiles`：用户完整档案（身高、体重、目标、饮食偏好等），由前端引导/档案页与后端 `/api` 共同使用。
3. **方案与每日记录**
   - `user_saved_meal_plan`：用户最后一次点击「保存到今日」时的一日三餐方案（再次登录可直接恢复）。
   - `user_daily_log`：按用户 + 日期保存每日饮食记录（intake）、饮水量（water_ml）与行为事件（events）。
   - `user_health_report`：最新健康报告（报告正文 + 数值化目标）。

> 对应建表与 RLS 策略 SQL 见 `docs/supabase-*.sql`，执行说明在 `docs/DEPLOY.md` 中有详细步骤。

---

## 脚本说明

| 命令 | 说明 |
|------|------|
| `npm run dev` | 仅启动前端（端口 3000）；需已启动后端，否则 AI 功能不可用 |
| `npm run server` | 仅启动后端 API（端口 3001），读取 `.env.local` / `.env` 中的 `DOUBAO_API_KEY` 等 |
| `npm run dev:all` | 同时启动后端与前端（推荐开发使用） |
| `npm run build` | 生产构建，输出到 `dist/` |
| `npm run preview` | 本地预览 `dist/` 构建结果（生产部署时需单独部署并运行后端） |
| `npm run lint` | 运行 `tsc --noEmit` 做类型检查（无产物输出） |
| `npm run benchmark:latency` | 本机 API 时延基准（需先 `npm run server`），详见 [docs/BENCHMARK-LATENCY.md](./docs/BENCHMARK-LATENCY.md) |

---

## 数据与隐私

- **本地数据**：未登录用户的档案、每日摄入、饮水量、食堂选择等仅存于浏览器 `localStorage`。
- **云端数据（Supabase）**：登录用户的档案、每日饮食/饮水记录、健康报告与最后一次保存的方案会同步到 Supabase，仅用于本应用功能；表均开启 RLS，仅本人可读写。
- **AI 数据**：上传的图片与咨询文本会发送至豆包（火山方舟）API，仅用于生成识别结果与回复，需遵守火山引擎/豆包的 API 条款与当地隐私法规。
- **免责**：所有营养与饮食建议均为 AI 生成、仅供参考，不构成医疗诊断；重大饮食或健康决策请咨询专业医生或营养师。
- **清空数据**：档案页提供「清空数据库记录」，会清除所有本地数据并重新进入引导流程。

---

## 版本与许可
 
- **版本**：2.2.0（见应用内「关于 Recipe」）
- **许可**：当前为私有项目（`"private": true`），未在 README 中声明开源协议；商用或二次开发前请确认授权。

---

*README 由项目结构与代码审查生成，如有变更请以仓库与代码为准。*
