/**
 * 深大南区食堂配餐压测：POST /api/ai/plan + selectedCanteen=szu_south
 * 走本地 planFromCanteenDishes，不调豆包，预期远快于 selectedCanteen=none。
 *
 * 用法：npm run benchmark:canteen
 * 需：npm run server 已启动；Supabase 可访问且 canteen_dishes（或 restaurant_menu）有数据。
 *
 * 环境变量：API_BASE 默认 http://127.0.0.1:4301
 */
const BASE = (process.env.API_BASE || 'http://127.0.0.1:4301').replace(/\/$/, '');
const N = Number(process.env.CANTEEN_BENCH_N || 10) || 10;

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
  return { ms: performance.now() - t0, status, err };
}

function stats(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / (ms.length || 1);
  const p50 = ms[Math.floor((ms.length - 1) * 0.5)] ?? ms[0] ?? 0;
  const p90 = ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.9))] ?? ms[ms.length - 1] ?? 0;
  const ok2xx = rows.filter((r) => r.status >= 200 && r.status < 300).length;
  const s503 = rows.filter((r) => r.status === 503).length;
  const s502 = rows.filter((r) => r.status === 502).length;
  return {
    n: rows.length,
    avg: +avg.toFixed(1),
    p50: +p50.toFixed(1),
    p90: +p90.toFixed(1),
    ok2xx,
    s503,
    s502,
  };
}

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

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

const prompt = `请规划今日三餐，目标总热量约1800kcal。只返回严格 JSON：{"breakfast":{"name":"测试早餐","calories":500,"desc":"d"},"lunch":{"name":"测试午餐","calories":600,"desc":"d"},"dinner":{"name":"测试晚餐","calories":700,"desc":"d"}}`;

const profile = { goal: 'maintain', age: 22, gender: 'male', height: 175, weight: 70 };

async function main() {
  console.log(`BASE=${BASE}  |  深大食堂 plan  |  n=${N}`);
  const up = await waitForHealth();
  if (!up) {
    console.error('无法连接', `${BASE}/api/health`, '请先 npm run server');
    process.exit(1);
  }

  const rows = [];
  for (let i = 0; i < N; i++) {
    const r = await timeOnce(() =>
      post('/api/ai/plan', {
        prompt,
        selectedCanteen: 'szu_south',
        profile,
        targets: { calories: 1800 },
        avoidNames: [],
      })
    );
    rows.push(r);
    console.log(
      `#${String(i + 1).padStart(2)}  ${r.ms.toFixed(0).padStart(7)} ms  HTTP ${r.status}${r.err ? `  ${r.err}` : ''}`
    );
    if (i < N - 1) await sleep(150);
  }

  const s = stats(rows);
  console.log('\n=== POST /api/ai/plan (szu_south 深大食堂算法，无豆包) ===');
  console.log(
    `汇总: avg=${s.avg}ms  P50≈${s.p50}ms  P90≈${s.p90}ms  2xx=${s.ok2xx}/${s.n}  502=${s.s502}  503=${s.s503}`
  );
  if (s.s503 > 0) {
    console.warn('\n提示: 出现 503 多为未配置 SUPABASE 或食堂表无数据，请检查 .env 与 Supabase 菜品表。');
  }
  if (s.ok2xx === 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
