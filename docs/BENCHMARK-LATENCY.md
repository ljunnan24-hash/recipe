# API 时延基准（本地一次实测）

**日期：** 2026-04-10  
**环境：** Windows，本机 `127.0.0.1:4301`，`npm run server`，已配置 `DOUBAO_API_KEY`（豆包可连通）。  
**命令：** `npm run benchmark:latency`（脚本：`scripts/latency-test.mjs`）  
**说明：** 时延为 **端到端**（客户端 `fetch` 起止），含本机 Node、公网 RTT、豆包推理；不同网络与模型负载下会波动。

## 汇总（论文表格可直接引用）

| 接口 | 次数 n | 平均 (ms) | P50 (ms) | P90 (ms) | 成功 2xx |
|------|--------|-------------|----------|----------|----------|
| `GET /api/health` | 10 | 3.4 | 3.2 | 3.6 | 10/10 |
| `POST /api/ai/chat` | 10 | 27 536 | 23 744 | 32 301 | 10/10 |
| `POST /api/ai/plan`（`selectedCanteen=none`） | 5 | 62 109 | 54 005 | 69 717 | 5/5 |
| `POST /api/ai/report` | 5 | 93 739 | 87 946 | 107 967 | 5/5 |

**整次全量脚本耗时约：** 18 分钟（主要为大模型串行等待）。

## 识图 `/api/ai/scan` 补充说明

- 脚本曾用 **1×1 JPEG** 占位图压测，豆包返回 **400**（最小边需 **≥14px**），接口表现为 **HTTP 500**，**不能**代表正常识图时延。
- 使用仓库内 `miniprogram/assets/meal-bg.png` **额外手动测 3 次**（脚本已改为默认使用该文件）：

| 样本 | 次数 | 平均 (ms) | 备注 |
|------|------|-------------|------|
| `meal-bg.png` | 3 | ≈42 638 | 均为 HTTP 200，识别结果随图变化，仅用于链路时延 |

## 复现

```bash
npm run server
# 另开终端
npm run benchmark:latency
# 仅健康检查 + 对话（较快）
npm run benchmark:latency -- --quick
# 若需测食堂算法路径（依赖 Supabase 菜品数据）
node scripts/latency-test.mjs --canteen
```

可选环境变量：`API_BASE`、`RECIPE_JWT`、`SCAN_IMAGE`（识图用图片路径）。
