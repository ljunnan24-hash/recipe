/**
 * Recipe API 时延测试（本机）
 * 用法：npm run benchmark:latency
 * 可选：--quick 仅测 health+chat；--canteen 额外测 szu_south 配餐
 *
 * 环境变量：
 *   API_BASE      默认 http://127.0.0.1:4301
 *   RECIPE_JWT    可选，Supabase access_token，用于测带 JWT 的请求
 *   SCAN_IMAGE    可选，识图压测用图片路径（默认 miniprogram/assets/meal-bg.png）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const BASE = (process.env.API_BASE || 'http://127.0.0.1:4301').replace(/\/$/, '');
const JWT = process.env.RECIPE_JWT || '';

// 豆包要求最小边 ≥14px。默认用仓库内 PNG 测识图时延（识别结果仅供参考）
const DEFAULT_SCAN_IMAGE = path.join(repoRoot, 'miniprogram', 'assets', 'meal-bg.png');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timeOnce(fn) {
  const t0 = performance.now();
  let status = 0;
  let err = '';
  try {
    const res = await fn();
    status = res.status;
    await res.text().catch(() => '');
  } catch (e) {
    err = e.message || String(e);
  }
  const ms = performance.now() - t0;
  return { ms, status, err };
}

function stats(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / (ms.length || 1);
  const p50 = ms[Math.floor((ms.length - 1) * 0.5)] ?? ms[0] ?? 0;
  const p90 = ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.9))] ?? ms[ms.length - 1] ?? 0;
  const ok2xx = rows.filter((r) => r.status >= 200 && r.status < 300).length;
  const s503 = rows.filter((r) => r.status === 503).length;
  const s502 = rows.filter((r) => r.status === 502).length;
  const s5xx = rows.filter((r) => r.status >= 500).length;
  const netErr = rows.filter((r) => r.err).length;
  return {
    n: rows.length,
    avg: +avg.toFixed(1),
    p50: +p50.toFixed(1),
    p90: +p90.toFixed(1),
    ok2xx,
    s503,
    s502,
    s5xx,
    netErr,
  };
}

async function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (JWT) headers.Authorization = `Bearer ${JWT}`;
  return fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function runBatch(label, n, fn) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(await timeOnce(fn));
    if (i < n - 1) await sleep(250);
  }
  const s = stats(rows);
  console.log(`\n=== ${label} (${n} 次) ===`);
  rows.forEach((r, i) => {
    const extra = r.err ? ` err=${r.err}` : '';
    console.log(`  #${String(i + 1).padStart(2)}  ${r.ms.toFixed(0).padStart(6)} ms  HTTP ${r.status}${extra}`);
  });
  console.log(
    `  汇总: avg=${s.avg}ms  P50≈${s.p50}ms  P90≈${s.p90}ms  2xx=${s.ok2xx}  503=${s.s503}  502=${s.s502}  5xx=${s.s5xx}  网络错=${s.netErr}`
  );
  return { label, rows, stats: s };
}

const args = new Set(process.argv.slice(2));

async function waitForHealth(maxWaitMs = 15000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  console.log(`BASE=${BASE}${JWT ? ' (带 RECIPE_JWT)' : ''}`);

  const up = await waitForHealth();
  if (!up) {
    console.error('\n错误: 无法连接', `${BASE}/api/health`, '请先运行: npm run server');
    process.exit(1);
  }

  const results = [];

  results.push(
    await runBatch('GET /api/health', 10, () => fetch(`${BASE}/api/health`))
  );

  results.push(
    await runBatch('POST /api/ai/chat', 10, () =>
      post('/api/ai/chat', {
        message: '我晚餐想少吃碳水，给三条可执行建议',
        systemInstruction: '你是营养师，回答简短。',
        profile: { goal: 'lose', weight: 70, height: 175, age: 22, gender: 'male' },
      })
    )
  );

  const prompt = `请规划今日三餐，目标总热量约1800kcal。只返回严格 JSON：{"breakfast":{"name":"测试早餐","calories":500,"desc":"d"},"lunch":{"name":"测试午餐","calories":600,"desc":"d"},"dinner":{"name":"测试晚餐","calories":700,"desc":"d"}}`;

  if (!args.has('--quick')) {
    results.push(
      await runBatch('POST /api/ai/plan (selectedCanteen=none)', 5, () =>
        post('/api/ai/plan', {
          prompt,
          selectedCanteen: 'none',
          profile: { goal: 'maintain', age: 22, gender: 'male', height: 175, weight: 70 },
          targets: { calories: 1800 },
          avoidNames: [],
        })
      )
    );

    results.push(
      await runBatch('POST /api/ai/report', 5, () =>
        post('/api/ai/report', {
          profile: {
            goal: 'lose',
            weight: 70,
            height: 175,
            age: 22,
            gender: 'male',
            activityLevel: 'moderate',
            trainingDays: 3,
          },
          targets: { calories: 1700, protein: 120, carbs: 180, fat: 55 },
        })
      )
    );

    const scanPath = process.env.SCAN_IMAGE || DEFAULT_SCAN_IMAGE;
    if (fs.existsSync(scanPath)) {
      const scanB64 = fs.readFileSync(scanPath).toString('base64');
      const ext = path.extname(scanPath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const label = `POST /api/ai/scan (${path.basename(scanPath)})`;
      results.push(
        await runBatch(label, 5, () => post('/api/ai/scan', { imageBase64: scanB64, mimeType: mime }))
      );
    } else {
      console.warn('\n跳过 scan：未找到', scanPath, '可设置环境变量 SCAN_IMAGE=绝对路径');
    }
  }

  // 可选：食堂算法路径（需 Supabase 有数据，否则 502/503）
  if (args.has('--canteen')) {
    results.push(
      await runBatch('POST /api/ai/plan (szu_south)', 5, () =>
        post('/api/ai/plan', {
          prompt,
          selectedCanteen: 'szu_south',
          profile: { goal: 'maintain', age: 22, gender: 'male', height: 175, weight: 70 },
          targets: { calories: 1800 },
          avoidNames: [],
        })
      )
    );
  }

  console.log('\n--- 论文用汇总表（请根据 2xx 比例判断是否有效 AI 样本）---');
  for (const r of results) {
    const { avg, p50, p90, ok2xx, s503 } = r.stats;
    console.log(
      `${r.label.padEnd(42)} avg=${String(avg).padStart(8)}ms  P50=${String(p50).padStart(8)}  P90=${String(p90).padStart(8)}  2xx=${ok2xx}/${r.stats.n}  503=${s503}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
