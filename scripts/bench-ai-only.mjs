/**
 * 仅压测 plan / report / scan（各 5 次），供论文填表；需本机已启动 server:4301
 * 用法：node scripts/bench-ai-only.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.API_BASE || 'http://127.0.0.1:4301').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timeOnce(fn) {
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fn();
    status = res.status;
    await res.text().catch(() => '');
  } catch {
    /* ignore */
  }
  return { ms: performance.now() - t0, status };
}

function summarize(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / (ms.length || 1);
  const p50 = ms[Math.floor((ms.length - 1) * 0.5)] ?? 0;
  const p90 = ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.9))] ?? 0;
  const ok = rows.filter((r) => r.status >= 200 && r.status < 300).length;
  return { avg: +avg.toFixed(1), p50: +p50.toFixed(1), p90: +p90.toFixed(1), ok, n: rows.length };
}

async function runBatch(label, n, fn) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push(await timeOnce(fn));
    if (i < n - 1) await sleep(250);
  }
  const s = summarize(rows);
  console.log(`\n=== ${label} (${n} 次) ===`);
  rows.forEach((r, i) => console.log(`  #${i + 1}  ${r.ms.toFixed(0).padStart(6)} ms  HTTP ${r.status}`));
  console.log(`  汇总: avg=${s.avg}ms  P50≈${s.p50}ms  P90≈${s.p90}ms  2xx=${s.ok}/${s.n}`);
  return { label, stats: s };
}

async function post(p, body) {
  return fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const prompt =
  '请规划今日三餐，目标总热量约1800kcal。只返回严格 JSON：' +
  '{"breakfast":{"name":"测试早餐","calories":500,"desc":"d"},"lunch":{"name":"测试午餐","calories":600,"desc":"d"},"dinner":{"name":"测试晚餐","calories":700,"desc":"d"}}';

const profile = { goal: 'maintain', age: 22, gender: 'male', height: 175, weight: 70 };

const imgPath = path.join(path.dirname(__dirname), 'miniprogram', 'assets', 'meal-bg.png');
const scanB64 = fs.readFileSync(imgPath).toString('base64');

const up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
if (!up) {
  console.error('无法连接', BASE, '请先 npm run server');
  process.exit(1);
}

await runBatch('POST /api/ai/plan (none)', 5, () =>
  post('/api/ai/plan', {
    prompt,
    selectedCanteen: 'none',
    profile,
    targets: { calories: 1800 },
    avoidNames: [],
  })
);

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
);

await runBatch('POST /api/ai/scan (meal-bg.png)', 5, () =>
  post('/api/ai/scan', { imageBase64: scanB64, mimeType: 'image/png' })
);
