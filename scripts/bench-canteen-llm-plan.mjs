/**
 * 深大南区食堂 LLM 候选约束配餐压测：POST /api/ai/plan + selectedCanteen=szu_south_ai
 * 调豆包 + 服务端 dishId 校验 + 数据库营养回填。
 *
 * 用法：npm run benchmark:canteen-llm
 * 需：npm run server；DOUBAO_API_KEY；Supabase 可访问且食堂表有数据。
 *
 * 环境变量：API_BASE 默认 http://127.0.0.1:4301；CANTEEN_LLM_BENCH_N 默认 10
 */
const BASE = (process.env.API_BASE || 'http://127.0.0.1:4301').replace(/\/$/, '');
const N = Number(process.env.CANTEEN_LLM_BENCH_N || 10) || 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timeOnce(fn) {
  const t0 = performance.now();
  let status = 0;
  let bodyText = '';
  let err = '';
  try {
    const res = await fn();
    status = res.status;
    bodyText = await res.text().catch(() => '');
  } catch (e) {
    err = e.message || String(e);
  }
  return { ms: performance.now() - t0, status, bodyText, err };
}

function stats(rows) {
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const avg = ms.reduce((a, b) => a + b, 0) / (ms.length || 1);
  const p50 = ms[Math.floor((ms.length - 1) * 0.5)] ?? ms[0] ?? 0;
  const p90 = ms[Math.min(ms.length - 1, Math.floor((ms.length - 1) * 0.9))] ?? ms[ms.length - 1] ?? 0;
  const ok2xx = rows.filter((r) => r.status >= 200 && r.status < 300).length;
  return {
    n: rows.length,
    avg: +avg.toFixed(1),
    p50: +p50.toFixed(1),
    p90: +p90.toFixed(1),
    ok2xx,
  };
}

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

async function waitForHealth(maxWaitMs = 20000) {
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

const prompt = `请为我规划今日三餐，优先清淡少油，适合在校学生。`;

const profile = {
  goal: 'maintain',
  age: 22,
  gender: 'male',
  height: 175,
  weight: 70,
};

function validatePlanShape(obj, allowedIds, allowedNames) {
  const keys = ['breakfast', 'lunch', 'dinner'];
  for (const k of keys) {
    const m = obj?.[k];
    if (!m || typeof m !== 'object') return { ok: false, reason: `缺少 ${k}` };
    if (typeof m.name !== 'string' || !m.name.trim()) return { ok: false, reason: `${k}.name` };
    if (typeof m.desc !== 'string') return { ok: false, reason: `${k}.desc` };
    const c = Number(m.calories);
    if (!Number.isFinite(c) || c <= 0) return { ok: false, reason: `${k}.calories` };
    if (m.source !== 'canteen_db_llm') return { ok: false, reason: `${k}.source` };
    const ids = Array.isArray(m.dishIds) ? m.dishIds : [];
    if (!ids.length) return { ok: false, reason: `${k}.dishIds 空` };
    for (const id of ids) {
      if (!allowedIds.has(String(id))) return { ok: false, reason: `未知 dishId ${id}` };
    }
    const names = Array.isArray(m.dishNames) ? m.dishNames : [];
    for (const n of names) {
      if (!allowedNames.has(String(n))) return { ok: false, reason: `菜名不在库：${n}` };
    }
  }
  return { ok: true };
}

async function main() {
  console.log(`BASE=${BASE}  |  szu_south_ai（LLM+食堂候选）  |  n=${N}`);
  const up = await waitForHealth();
  if (!up) {
    console.error('无法连接', `${BASE}/api/health`, '请先 npm run server');
    process.exit(1);
  }

  const menu = await getJson('/api/canteen/dishes?canteen=szu_south');
  const dishes = menu?.dishes || [];
  const allowedIds = new Set(dishes.map((d) => String(d.id ?? '').trim()).filter(Boolean));
  const allowedNames = new Set(dishes.map((d) => String(d.name ?? '').trim()).filter(Boolean));
  console.log(`候选库：${allowedIds.size} 个 id / ${allowedNames.size} 个菜名（来自 GET /api/canteen/dishes）\n`);

  const rows = [];
  let jsonOk = 0;
  let dishIdHitOk = 0;
  let namesOk = 0;

  for (let i = 0; i < N; i++) {
    const r = await timeOnce(() =>
      post('/api/ai/plan', {
        prompt,
        selectedCanteen: 'szu_south_ai',
        profile,
        targets: { calories: 1800 },
        avoidNames: [],
      })
    );
    rows.push(r);

    let parsed = null;
    try {
      parsed = r.bodyText ? JSON.parse(r.bodyText) : null;
    } catch {
      parsed = null;
    }

    if (r.status >= 200 && r.status < 300 && parsed) {
      const v = validatePlanShape(parsed, allowedIds, allowedNames);
      if (v.ok) jsonOk += 1;
      const idsValid =
        parsed?.breakfast?.dishIds &&
        parsed?.lunch?.dishIds &&
        parsed?.dinner?.dishIds &&
        [...parsed.breakfast.dishIds, ...parsed.lunch.dishIds, ...parsed.dinner.dishIds].every((id) =>
          allowedIds.has(String(id))
        );
      if (idsValid) dishIdHitOk += 1;
      const namesValid =
        parsed?.breakfast?.dishNames &&
        parsed?.lunch?.dishNames &&
        parsed?.dinner?.dishNames &&
        [...parsed.breakfast.dishNames, ...parsed.lunch.dishNames, ...parsed.dinner.dishNames].every((n) =>
          allowedNames.has(String(n))
        );
      if (namesValid) namesOk += 1;
    }

    console.log(
      `#${String(i + 1).padStart(2)}  ${r.ms.toFixed(0).padStart(7)} ms  HTTP ${r.status}${r.err ? `  ${r.err}` : ''}`
    );
    if (i < N - 1) await sleep(300);
  }

  const s = stats(rows);
  console.log('\n=== POST /api/ai/plan (szu_south_ai：豆包 + dishId 约束 + 数据库回填) ===');
  console.log(`HTTP 2xx 成功率: ${s.ok2xx}/${s.n} (${((100 * s.ok2xx) / s.n).toFixed(1)}%)`);
  console.log(`JSON 结构+canteen_db_llm+dishId 合法率: ${jsonOk}/${s.n} (${((100 * jsonOk) / s.n).toFixed(1)}%)`);
  console.log(`dishId 全命中候选库: ${dishIdHitOk}/${s.n} (${((100 * dishIdHitOk) / s.n).toFixed(1)}%)`);
  console.log(`dishNames 全命中候选库: ${namesOk}/${s.n} (${((100 * namesOk) / s.n).toFixed(1)}%)`);
  console.log(`时延: avg=${s.avg}ms  P50≈${s.p50}ms  P90≈${s.p90}ms`);

  if (allowedIds.size === 0) {
    console.warn('\n提示: 候选 id 为空，请确认 Supabase 食堂表有数据且 getCanteenDishes 返回 id。');
  }
  if (s.ok2xx === 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
