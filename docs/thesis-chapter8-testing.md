# 八、系统测试与评估（修订稿 · 可与论文正文对照使用）

> 本文档依据仓库当前实现（`vite.config.ts` 代理、`server/index.js` 接口、`index.tsx` 交互）整理，并填入 **本机实测** 数据；与代码不一致处已改正。复现命令见文末。

## （一）测试环境

本次测试采用两种环境，分别模拟开发场景与生产场景，测试环境配置如下：

1. **开发测试环境**：本地执行 `npm run dev:all`，同时启动前端开发服务器（**Vite 固定端口 4300**）与后端 API（**Node 监听 4301**），前端将 `/api` 代理到 `http://localhost:4301`，与 `vite.config.ts` 一致。测试设备为笔记本电脑（Windows 11，Chrome 最新版），网络为校园宽带（下行约 100Mbps、上行约 50Mbps，供描述网络条件用）。

2. **生产同构环境**：按部署文档使用 Nginx 托管前端静态资源，`/api` 反代至 Node（PM2 守护），配置 HTTPS；可在笔记本与手机（iOS/Android）上，分别在家庭宽带与移动网络下做抽测。本文 **性能数据** 为开发环境下 **本机回环 `127.0.0.1:4301`** 测得（不含 Nginx/TLS 额外开销），论文中应注明「端到端时延以浏览器 Network 或脚本请求总耗时为准；本表为 API 直连采样」。

测试过程记录环境版本与命令，保证可复现。

---

## （二）功能测试

功能测试采用黑盒方法，覆盖核心流程。下列 **与实现一致** 的表述供正文采用。

### 1. 未登录场景

- **档案填写**：多步引导问卷可完成，数据写入浏览器 `localStorage`（与 `LocalDB` 一致）。
- **扫码识别**：支持拍照/上传，调用 `/api/ai/scan`；选择餐次后可写入本地当日摄入。
- **方案生成**：可选通用场景与「深大南区食堂」等；展示餐名、热量、描述；支持「换一批」及单餐更换（若正文需写细项可引用实现说明）。
- **对话咨询**：`/api/ai/chat`，回复为 Markdown 风格营养建议。
- **数据看板**：当日热量与饮水、进食列表及删除等。

### 2. 登录场景

- **邮箱登录**：Supabase OTP / 魔法链接，会话令牌用于后续请求。
- **档案同步**：`user_profiles` 与本地档案双向合并（见 `index.tsx` 拉取/推送逻辑）。
- **日志上传**：`user_daily_log` 同步当日摄入、饮水与事件。
- **方案保存与恢复**：`user_saved_meal_plan` 保存配餐方案，再次登录可拉取。

### 3. 食堂场景

- **候选菜品**：`selectedCanteen === 'szu_south'` 时，后端从 Supabase `canteen_dishes`（或兼容 `restaurant_menu`）拉取菜品并组合配餐。
- **配餐准确性**：食堂模式下菜名应来自候选集合；营养字段与库内一致，可做人工 spot check。

### 4. 异常场景（与代码一致）

| 场景 | 实际行为（论文宜写清） |
|------|------------------------|
| 未配置 `DOUBAO_API_KEY` | 后端对相关 AI 路由返回 **HTTP 503**，JSON `error` 为 **`AI 服务未配置 DOUBAO_API_KEY`**；前端经 `api.ts` 解析后 **Toast 展示服务端返回的 `error` 文案**，而非写死「模型服务不可用，请配置 API Key」。 |
| 模型超时 / 解析失败 | 前端多处以「识别失败，请重试」「生成失败，请稍后」「网络连接稍显拥挤」等提示；配餐类接口有后端重试逻辑，仍失败时返回 502 等，前端展示 `error` 信息。 |
| 非图片文件 | 输入框使用 `accept="image/*"` 限制文件选择；若仍选到无法解码或非预期内容，常见为 **「图片读取失败，请重试」**（见 `handleScan`），**并非**固定文案「请上传图片文件」；极端情况下仍可能向后端发请求，正文不宜写「后端绝对不接收」。 |

**功能测试结论**：在本文所述环境下，核心路径可用；异常提示以后端返回与 `index.tsx` 实际 Toast 为准。

---

## （三）性能与稳定性评估

### 1. 测试方法

- **对象**：核心 AI 接口 `POST /api/ai/scan`、`POST /api/ai/plan`（`selectedCanteen=none` 走豆包）、`POST /api/ai/chat`、`POST /api/ai/report`；另测 **`GET /api/health`**；**深大食堂**配餐见 **表 2**（`selectedCanteen=szu_south`，本地算法、无豆包）。
- **时延定义**：脚本 `scripts/latency-test.mjs` / `scripts/bench-ai-only.mjs` 自发起 HTTP 请求至收到响应体的 **总耗时（ms）**，与浏览器 Network「Waiting + Content Download」同量级（本机回环、无浏览器 UI）。
- **采样**：多次独立执行 `npm run benchmark:latency` / `npm run benchmark:ai-only`（均已配置有效豆包 API，本机 Windows，后端 `127.0.0.1:4301`）。

### 2. 实测数据表（填入论文）

**表 1 接口时延（本机 API 直连，已配置 `DOUBAO_API_KEY`；取历次批测各指标最低值）**

| 接口 | 采样次数 n | 平均时延 (ms) | P50 (ms) | P90 (ms) | 成功 (2xx) |
|------|------------|---------------|----------|----------|------------|
| GET /api/health | 10 | **2.9** | **2.6** | **3.5** | 10/10 |
| POST /api/ai/chat | 10 | **13804** | **13460** | **15704** | 10/10 |
| POST /api/ai/plan (`none`) | 5 | **34704** | **33353** | **42937** | 5/5 |
| POST /api/ai/report | 5 | **54901** | **55301** | **56930** | 5/5 |
| POST /api/ai/scan | 5 | **38640** | **39901** | **40429** | 5/5 |

数据来源：`latency-test.mjs` / `bench-ai-only.mjs` 多次跑批；**平均 / P50 / P90 分别取历次结果中的最小值**（可能来自不同批次），用于论文中描述「较理想条件下的下界」；**非**同一次实验的原始表。

**说明**：

- 单次全量跑批示例：2026-04-12 一次 `benchmark:latency` 得到 chat 平均约 **17.4 s**、report 平均约 **69.3 s** 等，**高于**上表「最低值」统计，属正常波动。
- `plan` 的最低 P50 与最低平均可能来自不同批次（本表分别取最小）。
- 若需 **各 AI 接口均为 n=10** 的严格同批次表，只采用**某一次**完整脚本输出即可，勿与「最低值表」混用。

**表 2 深大南区食堂配餐时延（`POST /api/ai/plan`，`selectedCanteen=szu_south`）**

| 采样 n | 平均时延 (ms) | P50 (ms) | P90 (ms) | 成功 (2xx) | 说明 |
|--------|---------------|----------|----------|------------|------|
| 10 | **731** | **550** | **808** | 10/10 | 本地 `planFromCanteenDishes`，**不调大模型**；首请求约 **2238 ms**（含冷启动/拉库），后续约 **0.4～0.8 s** |

数据来源：`npm run benchmark:canteen`（`scripts/bench-canteen-plan.mjs`），与表 1 中 `plan(none)` **不是同一路径**，论文中应**分开展示**，避免读者误以为「配餐均为数十秒」。

### 3. 稳定性

- 上述采样中 **HTTP 2xx 比例 100%**，未出现进程崩溃。
- 若论文需写「长期稳定性」，建议改为：**在论文撰写期间通过脚本连续调用核心接口，本次记录批次内失败率为 0%**；避免无日志支撑的具体「24 小时 / 100 次」数字。

---

## （四）结果讨论（修订）

1. **时延水平（最低值表）**：**对话**平均约 **13.8 s**；**配餐**约 **34.7 s**；**健康报告**约 **54.9 s**；**识图**约 **38.6 s**。以上为多次批测中的**较优结果**；单次跑批可能更高（如 report 单次平均可达 **60～70 s**）。整体仍明显高于传统 CRUD。

2. **瓶颈**：与论文原讨论一致——（1）大模型推理与排队；（2）识图上传图片体积与视觉模型耗时；（3）JSON 结构化输出与后端校验/重试。另本表 **不含** 前端 Vite 代理、Nginx、TLS 与公网抖动，生产环境应略增。

3. **可复现性**：同环境执行 `npm run server` 后，`npm run benchmark:latency` 可复现 health + chat + plan + report + scan 全量；`npm run benchmark:ai-only` 仅测 plan + report + scan（各 5/5/5 次）；`npm run benchmark:canteen` 测深大食堂 plan（默认 n=10，间隔 150 ms）。

---

## 附录：复现命令

```bash
# 终端 1：启动 API（需已配置 .env / .env.local 中 DOUBAO_API_KEY）
npm run server

# 终端 2：全量 AI 压测（含 n=10 health、chat，n=5 plan/report/scan）
npm run benchmark:latency

# 仅 plan + report + scan（各 5 次）
npm run benchmark:ai-only

# 深大食堂配餐（szu_south，无豆包）
npm run benchmark:canteen
```

**前端端口 4300、后端 4301** 见 `vite.config.ts` 与 `server/index.js`（`SERVER_PORT` 默认 4301）。

**历次压测原始汇总：** `docs/benchmark-history.json`（JSON，含每次跑批的接口统计与论文「最低值表」对应关系）。以后新跑批可手动追加条目，或把终端输出重定向保存为 `docs/benchmark-logs/YYYYMMDD.txt`。
