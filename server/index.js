/**
 * Recipe 后端 API 服务
 * 代理所有 AI 调用，避免在前端暴露密钥；目前使用「豆包」（火山方舟）作为大模型。
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env.local') });
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express from 'express';
import { createClient } from '@supabase/supabase-js';
const app = express();
const PORT = Number(process.env.SERVER_PORT) || 4301;
const isProd = process.env.NODE_ENV === 'production';

// 经 Nginx 反代时获取真实客户端 IP（日志等）
if (isProd || process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);
}

// 跨域：仅当页面与 API 不同源时需要（同域 Nginx 反代 /api 则不必设置）
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (allowedOrigins.length > 0) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
}

// 豆包（火山方舟）配置
const doubaoEndpoint = process.env.DOUBAO_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/responses';
const doubaoApiKey = process.env.DOUBAO_API_KEY;
const doubaoModel = process.env.DOUBAO_MODEL || 'doubao-seed-2-0-mini-260215';
// 识图需使用支持视觉的模型，未配置时用通用模型（部分种子模型不支持图片）
const doubaoVisionModel = process.env.DOUBAO_VISION_MODEL || doubaoModel;

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

if (!doubaoApiKey) {
  console.warn('警告: 未设置 DOUBAO_API_KEY，AI 相关接口将返回 503。请在 .env 或 .env.local 中配置。');
}
if (!supabaseAnonKey) {
  console.warn('警告: 未设置 SUPABASE_ANON_KEY，深大食堂方案将无法从数据库拉取菜品，仍使用通用描述。');
}
if (!supabaseUrl && supabaseAnonKey) {
  console.warn('警告: 已设置 SUPABASE_ANON_KEY 但未设置 SUPABASE_URL，Supabase 相关能力不可用。');
}

function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.SUPABASE_TIMEOUT_MS) || 6000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: fetchWithTimeout } })
  : null;

function createSupabaseForUserJwt(jwt) {
  if (!supabaseUrl || !supabaseAnonKey || !jwt) return null;
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      fetch: fetchWithTimeout,
      headers: { Authorization: `Bearer ${jwt}` },
    },
  });
}

function getBearerJwt(req) {
  const h = req.headers?.authorization || req.headers?.Authorization;
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function loadUserProfileFromDb(req) {
  const jwt = getBearerJwt(req);
  if (!jwt) return null;
  const sb = createSupabaseForUserJwt(jwt);
  if (!sb) return null;
  const { data, error } = await sb
    .from('user_profiles')
    .select('profile,updated_at')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[user_profiles] read failed', error.message || error);
    return null;
  }
  if (!data || !data.profile || typeof data.profile !== 'object') return null;
  return data.profile;
}

function mergeProfiles(dbProfile, clientProfile) {
  const a = dbProfile && typeof dbProfile === 'object' ? dbProfile : {};
  const b = clientProfile && typeof clientProfile === 'object' ? clientProfile : {};
  // 客户端优先（最新编辑），数据库补齐缺省字段
  return { ...a, ...b };
}

/** 调用豆包 responses 接口 */
async function callDoubao(body) {
  if (!doubaoApiKey) {
    throw new Error('AI 服务未配置 DOUBAO_API_KEY');
  }
  const resp = await fetch(doubaoEndpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${doubaoApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`豆包接口错误 ${resp.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`豆包返回非 JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * 从 Supabase 的权威营养成分表中按中文名称查找 100g 标准营养数据
 * 当前使用的表：food_nutrition_authority
 * 关键列：
 * - name_cn
 * - energy_kcal_per_100g
 * - protein_g_per_100g
 * - carbs_g_per_100g 或 carb_g_per_100g（两者其一）
 * - fat_g_per_100g
 */
const authorityNutritionCache = new Map();

function normalizeFoodName(raw) {
  return String(raw || '')
    .trim()
    .replace(/（.*?）/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\s+/g, '');
}

async function getAuthorityNutritionByName(name) {
  if (!supabase) return null;
  if (!name || typeof name !== 'string') return null;

  const q = normalizeFoodName(name);
  if (!q) return null;

  if (authorityNutritionCache.has(q)) {
    return authorityNutritionCache.get(q);
  }

  try {
    // 先按中文名精确匹配
    let { data, error } = await supabase
      .from('food_nutrition_authority')
      .select('*')
      .eq('name_cn', q)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[getAuthorityNutritionByName] exact match error', error);
      data = null;
    }

    // 精确命中失败再走模糊兜底
    if (!data) {
      const { data: fuzzyData, error: fuzzyError } = await supabase
        .from('food_nutrition_authority')
        .select('*')
        .ilike('name_cn', `%${q}%`)
        .limit(1)
        .maybeSingle();
      if (fuzzyError) {
        console.error('[getAuthorityNutritionByName] fuzzy match error', fuzzyError);
        return null;
      }
      data = fuzzyData || null;
    }

    if (!data) return null;

    authorityNutritionCache.set(q, data);

    return data;
  } catch (e) {
    console.error('[getAuthorityNutritionByName] unexpected error', e);
    return null;
  }
}

async function callDoubaoWithJsonFormatFallback(body) {
  try {
    return await callDoubao(body);
  } catch (e) {
    // 部分网关/模型可能不支持 text.format，遇到报错时自动降级重试，避免整条链路不可用
    if (body && typeof body === 'object' && body.text) {
      const downgraded = { ...body };
      delete downgraded.text;
      return await callDoubao(downgraded);
    }
    throw e;
  }
}

/**
 * 从豆包响应中抽取纯文本
 *
 * 火山方舟 Responses API 的返回通常是：
 * - output_text: string（可能存在）
 * - output: [{ type: "message", content: [{ type: "output_text", text: "..." }, ...] }, ...]
 *
 * 这里也兼容部分旧的 choices 结构，避免切换接口时全挂。
 */
function extractDoubaoText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;

  const output = data?.output;
  if (Array.isArray(output) && output.length) {
    // 优先取最后一条 assistant message
    const messages = output.filter((o) => o?.type === 'message');
    const msg = messages.length ? messages[messages.length - 1] : output[output.length - 1];
    const content = msg?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((c) => {
        if (typeof c === 'string') return c;
        if (c?.type === 'output_text' || c?.type === 'message_content_text' || c?.type === 'text') {
          return c.text ?? c.content ?? '';
        }
        return c.text ?? c.content ?? '';
      }).join('');
    }
  }

  const choice = data?.output?.choices?.[0] || data?.choices?.[0];
  if (!choice) return '';
  let content = choice.message?.content;
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c?.type === 'message_content_text' || c?.type === 'text') return c.text ?? c.content ?? '';
      return c.text ?? c.content ?? '';
    }).join('');
  }
  if (typeof content === 'object' && ('text' in content || 'content' in content)) {
    return content.text ?? content.content ?? '';
  }
  return String(content);
}

/** 从模型回复中提取 JSON 字符串（去掉 ```json ... ``` 包裹） */
function extractJsonFromText(text) {
  if (!text || typeof text !== 'string') return text;
  const trimmed = text.trim();
  const codeBlock = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (codeBlock) return codeBlock[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}') + 1;
  if (start >= 0 && end > start) return trimmed.slice(start, end);
  return trimmed;
}

/**
 * 从 Supabase 拉取指定食堂的菜品列表（用于 AI 推荐）
 *
 * 兼容两种表结构：
 * - canteen_dishes（项目原结构）
 * - restaurant_menu（用户现有表：dish_name/category/calories/remark/price）
 */
async function getCanteenDishes(canteenKey) {
  if (!supabase) {
    throw new Error('未配置 SUPABASE_ANON_KEY，无法连接 Supabase');
  }

  const normalizeNetworkError = (msg) => {
    const m = String(msg || '');
    if (m.toLowerCase().includes('fetch failed')) {
      return '无法连接到 Supabase（网络/防火墙限制或 Supabase 服务不可达）';
    }
    return null;
  };

  const { data: d1, error: e1 } = await supabase
    .from('canteen_dishes')
    .select('*')
    .eq('canteen_key', canteenKey)
    .order('category');

  if (!e1) {
    return (d1 || []).map((r, i) => ({
      id: r.id != null && r.id !== '' ? String(r.id) : `dish_${i}`,
      name: r.name,
      calories: Number(r.calories) || 0,
      protein: Number(r.protein) || 0,
      carbs: Number(r.carbs ?? r.carb ?? r.carb_g) || 0,
      fat: Number(r.fat) || 0,
      category: r.category || 'lunch',
      description: typeof r.description === 'string' ? r.description : '',
    }));
  }

  const msg1 = String(e1?.message || '');
  const net1 = normalizeNetworkError(msg1);
  if (net1) throw new Error(net1);

  // 如果 canteen_dishes 不存在，降级读用户现有表 restaurant_menu
  const tableMissing =
    msg1.includes("Could not find the table 'public.canteen_dishes'") ||
    msg1.toLowerCase().includes('schema cache');

  if (!tableMissing) {
    throw new Error(`Supabase 查询失败：${msg1 || 'unknown error'}`);
  }

  const { data: d2, error: e2 } = await supabase
    .from('restaurant_menu')
    .select('dish_name, calories, category, remark')
    .order('category');

  if (e2) {
    const msg2 = String(e2?.message || '');
    const net2 = normalizeNetworkError(msg2);
    if (net2) throw new Error(net2);
    if (msg2.includes("Could not find the table 'public.restaurant_menu'") || msg2.toLowerCase().includes('schema cache')) {
      throw new Error('Supabase 未找到表 restaurant_menu。请确认你昨天创建的表在 public schema，并且当前 SUPABASE_URL/SUPABASE_ANON_KEY 指向同一个项目。');
    }
    throw new Error(`Supabase 查询失败：${msg2 || 'unknown error'}`);
  }

  // restaurant_menu 不区分食堂；此处保留 canteenKey 参数以保持调用签名一致
  return (d2 || []).map((r, i) => ({
    id: r.id != null && r.id !== '' ? String(r.id) : `dish_${i}`,
    name: r.dish_name,
    calories: Number(r.calories) || 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    category: r.category || 'lunch',
    description: typeof r.remark === 'string' ? r.remark : '',
  }));
}

/** 将食堂菜品数组转为 dishId -> 记录 Map（供 szu_south_ai 校验与回填） */
function buildDishMapFromDishes(dishes) {
  const map = new Map();
  (dishes || []).forEach((d, i) => {
    let id =
      d && d.id != null && String(d.id).trim() !== '' ? String(d.id).trim() : `dish_${i}`;
    let candidate = id;
    let n = 0;
    while (map.has(candidate)) {
      n += 1;
      candidate = `${id}__dup${n}`;
    }
    id = candidate;
    map.set(id, {
      id,
      name: String(d.name || ''),
      calories: Number(d.calories) || 0,
      protein: Number(d.protein) || 0,
      carbs: Number(d.carbs) || 0,
      fat: Number(d.fat) || 0,
      category: d.category || 'lunch',
      description: typeof d.description === 'string' ? d.description : '',
    });
  });
  return map;
}

function goalLabelFromProfile(profile) {
  const g = profile?.goal || 'maintain';
  if (g === 'lose') return '减脂';
  if (g === 'gain') return '增肌';
  if (g === 'shape') return '塑形';
  return '维持';
}

/**
 * 校验 LLM 输出的 dishIds 方案
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateDishIdPlan(plan, dishMap, avoidNames) {
  const mealKeys = ['breakfast', 'lunch', 'dinner'];
  const avoidSet = new Set((avoidNames || []).map((s) => String(s || '').trim()).filter(Boolean));

  const nameHitsAvoid = (name) => {
    const n = String(name || '').trim();
    if (!n) return false;
    for (const a of avoidSet) {
      if (a && (n === a || n.includes(a))) return true;
    }
    return false;
  };

  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: '解析结果不是 JSON 对象' };
  }

  for (const k of mealKeys) {
    const block = plan[k];
    if (!block || typeof block !== 'object') {
      return { ok: false, error: `缺少餐次 ${k} 或其格式不正确` };
    }
    const dishIds = block.dishIds;
    if (!Array.isArray(dishIds) || dishIds.length === 0) {
      return { ok: false, error: `${k}.dishIds 必须为非空数组` };
    }
    if (typeof block.reason !== 'string' || !block.reason.trim()) {
      return { ok: false, error: `${k}.reason 必须为非空字符串` };
    }

    const seenLocal = new Set();
    for (const rawId of dishIds) {
      const sid = String(rawId ?? '').trim();
      if (!sid) {
        return { ok: false, error: `${k}.dishIds 中存在空 id` };
      }
      if (!dishMap.has(sid)) {
        return { ok: false, error: `未知 dishId「${sid}」，只能从候选列表中选择` };
      }
      if (seenLocal.has(sid)) {
        return { ok: false, error: `同一餐「${k}」内 dishId 重复：${sid}` };
      }
      seenLocal.add(sid);
      const dish = dishMap.get(sid);
      if (nameHitsAvoid(dish.name)) {
        return { ok: false, error: `菜品「${dish.name}」命中忌口/避免列表` };
      }
    }
  }

  const used = [];
  for (const k of mealKeys) {
    for (const rawId of plan[k].dishIds) {
      used.push(String(rawId).trim());
    }
  }
  const cnt = {};
  for (const id of used) {
    cnt[id] = (cnt[id] || 0) + 1;
  }
  const dup = Object.keys(cnt).filter((id) => cnt[id] > 1);
  if (dup.length) {
    return { ok: false, error: `三餐重复选用同一菜品（dishId）：${dup.join('、')}` };
  }

  return { ok: true };
}

/**
 * 按 dishIds 从数据库映射累加营养字段并生成与现有前端兼容的三餐结构
 */
function hydrateDishIdPlan(plan, dishMap) {
  const mealKeys = ['breakfast', 'lunch', 'dinner'];
  const out = {};
  for (const k of mealKeys) {
    const dishIds = plan[k].dishIds.map((id) => String(id).trim());
    const dishes = dishIds.map((id) => dishMap.get(id)).filter(Boolean);
    let calories = 0;
    let protein = 0;
    let carbs = 0;
    let fat = 0;
    for (const d of dishes) {
      calories += Number(d.calories) || 0;
      protein += Number(d.protein) || 0;
      carbs += Number(d.carbs) || 0;
      fat += Number(d.fat) || 0;
    }
    const dishNames = dishes.map((d) => d.name);
    const name = dishNames.join(' + ');
    const reason = typeof plan[k].reason === 'string' ? plan[k].reason.trim() : '';
    const detailParts = dishes.map((d) => {
      const c = Number(d.calories) || 0;
      return `${d.name}（${c}kcal）`;
    });
    const desc = `${reason}；包含：${detailParts.join('；')}`;
    out[k] = {
      name,
      calories: Math.round(calories),
      protein: Number(protein.toFixed(1)),
      carbs: Number(carbs.toFixed(1)),
      fat: Number(fat.toFixed(1)),
      desc,
      dishNames,
      dishIds,
      source: 'canteen_db_llm',
      category: dishes[0]?.category,
    };
  }
  return out;
}

function buildSzuSouthAiUserPrompt({
  basePrompt,
  candidatesPayload,
  mergedProfile,
  targets,
  mergedAvoidList,
  goalLabel,
}) {
  const targetCal = Number(targets?.calories) || 1800;
  const avoidLine = mergedAvoidList.length ? mergedAvoidList.join('、') : '无';
  return (
    `${basePrompt}\n\n` +
    `你是高校食堂营养配餐助手。你只能从下方「候选菜品」的 id（即 dishId）中选择；禁止编造候选列表之外的菜品、id、热量或营养素。\n\n` +
    `【候选菜品】（JSON 数组；每条含 id/name/calories/protein/carbs/fat/category/description；输出中的 dishIds 必须逐一对应下列对象的 id 字段）\n` +
    `${candidatesPayload}\n\n` +
    `【每日目标热量】约 ${targetCal} kcal（三餐可按约 25% / 40% / 35% 分配，可微调）。\n` +
    `【用户饮食目标】${goalLabel}（请在每餐 reason 中体现该目标与选菜逻辑）。\n` +
    `【忌口/避免菜名】${avoidLine}\n\n` +
    `【权威用户档案（服务器侧；如与上文冲突以此为准）】\n${JSON.stringify(mergedProfile)}\n\n` +
    `输出要求：只输出一个 JSON 对象，不要 Markdown，不要代码块，不要在 JSON 外输出任何文字。\n` +
    `结构必须为：\n` +
    `{"breakfast":{"dishIds":["…"],"reason":"…"},"lunch":{"dishIds":["…"],"reason":"…"},"dinner":{"dishIds":["…"],"reason":"…"}}\n` +
    `规则：\n` +
    `1) dishIds 中每一项必须是上表「候选菜品」中某条的 id，禁止使用候选之外的 id。\n` +
    `2) 禁止在 JSON 中自行输出每餐或菜品的 calories、protein、carbs、fat；服务器仅根据你所选 id 从数据库汇总。\n` +
    `3) 每餐 dishIds 至少含 1 个 id；同一餐内不得重复同一 id。\n` +
    `4) 同一 dishId 在早餐/午餐/晚餐中全天最多出现一次（避免三餐重复同一道菜）。\n` +
    `5) reason 用简短中文说明选菜理由，并结合用户目标（减脂/增肌/维持/塑形）。\n`
  );
}

/**
 * 多智能体协同（服务端分层，路由仍集中在 index.js）：
 * - vision + 权威成分表：/api/ai/scan（图像识别 → 营养数值纠偏）
 * - 食堂本地组合优化：./agents/canteenPlanner.js（可被脚本单独调用；/api/ai/plan 深大路径已统一为 LLM+dishId）
 * - 食堂 LLM 候选约束：/api/ai/plan + selectedCanteen=szu_south_ai（仅选 dishId，营养服务端回填）
 * - 自然语言配餐：本文件 /api/ai/plan 中豆包 JSON 生成 + 校验
 */

// base64 图片会比原图体积大不少，10mb 容易在手机拍照时触顶导致识别失败
app.use(express.json({ limit: '25mb' }));

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ ok: true, service: 'recipe-api' });
});

// 调试接口：生产环境默认关闭，避免泄露 Key/库表信息；需要排查时可设 ENABLE_DEBUG_ROUTES=1
const debugRoutes = !isProd || process.env.ENABLE_DEBUG_ROUTES === '1';
if (debugRoutes) {
  app.get('/api/test-doubao', async (_, res) => {
    if (!doubaoApiKey) {
      return res.json({ ok: false, error: '未配置 DOUBAO_API_KEY' });
    }
    try {
      const body = {
        model: doubaoModel,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '只说一句话：你好' }] },
        ],
      };
      const data = await callDoubao(body);
      const text = extractDoubaoText(data);
      res.json({ ok: true, text: text || '(空回复)' });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });
}

// 食堂菜品列表（供前端展示或调试）
app.get('/api/canteen/dishes', async (req, res) => {
  const canteen = req.query.canteen || 'szu_south';
  try {
    const dishes = await getCanteenDishes(canteen);
    res.json({ dishes });
  } catch (err) {
    console.error('[api/canteen/dishes]', err);
    res.status(502).json({ error: err?.message || '获取失败' });
  }
});

if (debugRoutes) {
  app.get('/api/test-supabase', async (_, res) => {
    if (!supabase) {
      return res.json({ ok: false, error: '未配置 SUPABASE_ANON_KEY' });
    }
    try {
      const tryTable = async (table) => {
        const { data, error } = await supabase.from(table).select('*').limit(1);
        return { table, data, error };
      };

      const r1 = await tryTable('restaurant_menu');
      if (!r1.error) {
        return res.json({ ok: true, table: r1.table, sampleRows: Array.isArray(r1.data) ? r1.data.length : 0 });
      }

      const msg1 = String(r1.error?.message || '');
      if (msg1.toLowerCase().includes('fetch failed')) {
        return res.json({ ok: false, error: '无法连接到 Supabase（网络/防火墙限制或 Supabase 服务不可达）' });
      }

      const r2 = await tryTable('canteen_dishes');
      if (!r2.error) {
        return res.json({ ok: true, table: r2.table, sampleRows: Array.isArray(r2.data) ? r2.data.length : 0 });
      }

    const msg2 = String(r2.error?.message || '');
    const missingRestaurant = msg1.includes("Could not find the table 'public.restaurant_menu'") || msg1.toLowerCase().includes('schema cache');
    const missingCanteen = msg2.includes("Could not find the table 'public.canteen_dishes'") || msg2.toLowerCase().includes('schema cache');

    if (missingRestaurant && missingCanteen) {
      return res.json({ ok: false, error: 'Supabase 里未找到 restaurant_menu 或 canteen_dishes。请确认表在 public schema，且 SUPABASE_URL/SUPABASE_ANON_KEY 指向正确项目。' });
    }

    return res.json({ ok: false, error: `Supabase 查询失败：${msg1 || msg2 || 'unknown error'}` });
  } catch (e) {
    res.json({ ok: false, error: e?.message || 'test failed' });
  }
  });
}

// 食物识别：上传图片 base64，调用豆包识图并返回营养成分 JSON
// 结构化字段（后续可与《中国食物成分表》结合）：
// - name: 食物名称
// - calories/protein/carbs/fat: 以当前估算份量为基准的营养值
// - estimatedWeightGrams: 估算重量（g），用于后续基于权威成分表按 100g 换算
// - portionSize: 份量感知：small/medium/large 等
// - foodType: staple/meat/veg/soup 等粗分类
app.post('/api/ai/scan', async (req, res) => {
  if (!doubaoApiKey) {
    return res.status(503).json({ error: 'AI 服务未配置 DOUBAO_API_KEY' });
  }
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: '缺少 imageBase64' });
    }
    const imageUrl = `data:${mimeType || 'image/jpeg'};base64,${imageBase64}`;
    console.log('[api/ai/scan] 收到识图请求，调用豆包 model=', doubaoVisionModel);
    const body = {
      model: doubaoVisionModel,
      // 强制模型输出 JSON 结构，减少“多余解释文字/Markdown”导致的解析失败
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageUrl },
            {
              type: 'input_text',
              text:
                '你是营养学与食物体积估算专家，请识别图片中的主要食物，' +
                '只返回一个严格的 JSON 对象，不要有 Markdown/解释/代码块，其结构为：\\n' +
                '{"name":"食物名称",' +
                '"calories":数字,' +
                '"protein":数字,' +
                '"carbs":数字,' +
                '"fat":数字,' +
                '"estimatedWeightGrams":数字,' +
                '"portionSize":"small/medium/large 或其他字符串",' +
                '"foodType":"staple/meat/veg/soup/other 等"}\\n' +
                '其中：\\n' +
                '1) calories/protein/carbs/fat 请按当前估算重量给出，不要按 100g；\\n' +
                '2) estimatedWeightGrams 为你估计的“可食用部分”的总重量（单位 g）：例如汤面只算面+菜+肉，不算汤；带骨肉只算可食用的肉，不算骨头；\\n' +
                '3) 如果图片中存在多种食物，请聚焦用户最可能想记录的那一份主食/主菜。'
            },
          ],
        },
      ],
    };
    const data = await callDoubaoWithJsonFormatFallback(body);
    const rawText = extractDoubaoText(data);
    const jsonStr = extractJsonFromText(rawText);
    let result;
    try {
      const parsed = JSON.parse(jsonStr || '{}') || {};
      const rawCalories = Number(parsed.calories) || 0;
      const rawProtein = Number(parsed.protein) || 0;
      const rawCarbs = Number(parsed.carbs) || 0;
      const rawFat = Number(parsed.fat) || 0;
      let estWeight = Number(parsed.estimatedWeightGrams);
      const portionSize = typeof parsed.portionSize === 'string' ? parsed.portionSize : '';
      const foodType = typeof parsed.foodType === 'string' ? parsed.foodType : '';

      // 当模型未给出估算重量或给得过小/不合理时，按粗粒度规则给一个兜底估值（单位 g）
      if (!Number.isFinite(estWeight) || estWeight <= 0) {
        // 基于食物类型和份量大小的简单规则（可后续调参）
        const normPortion = portionSize.toLowerCase();
        const normType = foodType.toLowerCase();
        const pickByPortion = (baseSmall, baseMedium, baseLarge) => {
          if (normPortion.includes('small')) return baseSmall;
          if (normPortion.includes('large')) return baseLarge;
          if (normPortion) return baseMedium;
          return baseMedium;
        };

        if (normType.includes('staple')) {
          // 主食：例如一碗米饭/一盘面
          estWeight = pickByPortion(100, 150, 220);
        } else if (normType.includes('meat')) {
          // 肉菜：通常稍少
          estWeight = pickByPortion(80, 120, 180);
        } else if (normType.includes('veg')) {
          // 蔬菜类
          estWeight = pickByPortion(80, 120, 180);
        } else if (normType.includes('soup')) {
          // 汤/粥
          estWeight = pickByPortion(150, 220, 300);
        } else {
          // 未知类型：给一个中等值
          estWeight = pickByPortion(80, 130, 200);
        }
      }

      // 兜底处理：防止模型遗漏字段或类型不正确
      result = {
        name: typeof parsed.name === 'string' ? parsed.name : '未知',
        calories: rawCalories,
        protein: rawProtein,
        carbs: rawCarbs,
        fat: rawFat,
        estimatedWeightGrams: estWeight,
        portionSize: portionSize || undefined,
        foodType: foodType || undefined,
      };
    } catch {
      result = {
        name: '解析失败',
        calories: 0,
        protein: 0,
        carbs: 0,
        fat: 0,
        estimatedWeightGrams: 0,
      };
    }

    // 若成分表命中且有估算重量，则使用成分表 per 100g * 估算重量 精算营养值
    try {
      if (result.name && result.estimatedWeightGrams && result.estimatedWeightGrams > 0) {
        const authority = await getAuthorityNutritionByName(result.name);
        if (authority) {
          const w = Number(result.estimatedWeightGrams) || 0;
          const per100 = (x) => Number(x) || 0;

          const kcal100 = per100(authority.energy_kcal_per_100g);
          const p100 = per100(authority.protein_g_per_100g);
          // carbs 列命名可能是 carbs_g_per_100g 或 carb_g_per_100g，二者择一
          const c100 = per100(
            authority.carbs_g_per_100g !== undefined
              ? authority.carbs_g_per_100g
              : authority.carb_g_per_100g
          );
          const f100 = per100(authority.fat_g_per_100g);

          if (w > 0 && (kcal100 || p100 || c100 || f100)) {
            result.calories = Math.round(kcal100 * w / 100);
            result.protein = Number((p100 * w / 100).toFixed(1));
            result.carbs = Number((c100 * w / 100).toFixed(1));
            result.fat = Number((f100 * w / 100).toFixed(1));
            result.source = 'china_food_table';
          }
        }
      }
    } catch (e) {
      console.error('[api/ai/scan] authority nutrition fallback failed', e);
      // 出错时只保留模型原始结果
    }

    res.json(result);
  } catch (err) {
    console.error('[api/ai/scan]', err);
    res.status(500).json({ error: err?.message || '识别失败' });
  }
});

// 生成三餐方案：传入 prompt、selectedCanteen；深大食堂时从 Supabase 拉取菜品并注入 prompt
app.post('/api/ai/plan', async (req, res) => {
  try {
    const { prompt, selectedCanteen, profile, targets, avoidNames, refreshMealKey, fixedMeals } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: '缺少 prompt' });
    }
    if (!doubaoApiKey) {
      return res.status(503).json({ error: 'AI 服务未配置 DOUBAO_API_KEY' });
    }
    /**
     * 分支与环境变量（本路由）：
     * - selectedCanteen === 'szu_south' 或 'szu_south_ai'：豆包仅从数据库候选 dishId 选菜 + 服务端回填营养；依赖 DOUBAO_API_KEY、SUPABASE_URL、SUPABASE_ANON_KEY。（二者等价，保留 szu_south 兼容旧客户端）
     * - selectedCanteen === 'none' 或其它：通用豆包 JSON；依赖 DOUBAO_API_KEY；可选 Authorization Bearer + Supabase 以合并云端 user_profiles。
     */
    const isSzuSouthCanteenLlm =
      selectedCanteen === 'szu_south_ai' || selectedCanteen === 'szu_south';
    const mergedProfile = mergeProfiles(await loadUserProfileFromDb(req), profile);

    const mealKeys = ['breakfast', 'lunch', 'dinner'];
    const mealLabel = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };

    const mergeAvoidFromRequest = () => {
      const raw = Array.isArray(avoidNames) ? avoidNames : [];
      const declined = Array.isArray(mergedProfile?.declinedDishNames) ? mergedProfile.declinedDishNames : [];
      return [...new Set([
        ...raw.map((s) => String(s || '').trim()).filter(Boolean),
        ...declined.map((s) => String(s || '').trim()).filter(Boolean),
      ])];
    };
    const mergedAvoidList = mergeAvoidFromRequest();

    const validateSingleMealRefresh = () => {
      if (!refreshMealKey || !mealKeys.includes(refreshMealKey)) return { ok: true };
      if (!fixedMeals || typeof fixedMeals !== 'object') {
        return { ok: false, error: '单餐换一批需要同时上传 fixedMeals（其余两餐）' };
      }
      for (const k of mealKeys) {
        if (k === refreshMealKey) continue;
        const fm = fixedMeals[k];
        if (!fm || typeof fm !== 'object' || typeof fm.name !== 'string' || !fm.name.trim()) {
          return { ok: false, error: '单餐换一批需要其余两餐的完整 name/calories/desc' };
        }
        const cals = Number(fm.calories);
        if (!Number.isFinite(cals) || cals <= 0) {
          return { ok: false, error: '单餐换一批需要其余两餐的有效热量' };
        }
      }
      return { ok: true };
    };
    const refreshCheck = validateSingleMealRefresh();
    if (!refreshCheck.ok) {
      return res.status(400).json({ error: refreshCheck.error || '参数错误' });
    }

    if (isSzuSouthCanteenLlm && refreshMealKey) {
      return res.status(400).json({ error: '深大食堂 AI 配餐暂不支持单餐换一批，请重新生成全天三餐' });
    }

    if (isSzuSouthCanteenLlm && !supabase) {
      return res.status(503).json({ error: '未配置 SUPABASE_ANON_KEY，无法从深大食堂数据库挑选菜品' });
    }

    // 深大食堂 + LLM：仅从候选 dishId 选菜，营养由数据库回填（szu_south / szu_south_ai 均走此路径）
    if (isSzuSouthCanteenLlm) {
      let dishes;
      try {
        dishes = await getCanteenDishes('szu_south');
      } catch (e) {
        return res.status(502).json({ error: e?.message || '无法连接食堂数据库' });
      }
      if (!dishes.length) {
        return res.status(503).json({ error: '深大食堂数据库暂无菜品数据（canteen_dishes 为空）' });
      }

      const dishMap = buildDishMapFromDishes(dishes);
      const candidatesPayload = JSON.stringify(
        Array.from(dishMap.values()).map(
          ({ id, name, calories, protein, carbs, fat, category, description }) => ({
            id,
            name,
            calories,
            protein,
            carbs,
            fat,
            category,
            description,
          })
        )
      );
      const goalLabel = goalLabelFromProfile(mergedProfile);
      const baseAiPrompt = buildSzuSouthAiUserPrompt({
        basePrompt: prompt,
        candidatesPayload,
        mergedProfile,
        targets,
        mergedAvoidList,
        goalLabel,
      });

      const parseDishPlan = (data) => {
        try {
          const rawText = extractDoubaoText(data);
          const jsonStr = extractJsonFromText(rawText);
          return JSON.parse(jsonStr || '{}');
        } catch {
          return null;
        }
      };

      let lastFeedback = '';
      let lastText = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const textBlock =
          attempt === 0
            ? baseAiPrompt
            : `${baseAiPrompt}\n\n【上一轮输出存在问题】${lastFeedback}。请重新输出完整 JSON，必须只选择候选列表中的 dishId，遵守每餐至少 1 个 dishId、全天同一 dishId 不得重复、每餐 reason 必填；禁止输出候选之外的 id 或自编营养素。\n` +
              (lastText ? `（上一轮原文片段：${String(lastText).slice(0, 200)}）\n` : '');

        const body = {
          model: doubaoModel,
          text: { format: { type: 'json_object' } },
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: textBlock }],
            },
          ],
        };

        try {
          const data = await callDoubaoWithJsonFormatFallback(body);
          lastText = extractDoubaoText(data) || '';
          const parsed = parseDishPlan(data);
          if (parsed == null) {
            lastFeedback = 'JSON 解析失败';
            continue;
          }
          const v = validateDishIdPlan(parsed, dishMap, mergedAvoidList);
          if (!v.ok) {
            lastFeedback = v.error;
            continue;
          }
          const hydrated = hydrateDishIdPlan(parsed, dishMap);
          return res.json(hydrated);
        } catch (e) {
          lastFeedback = e?.message || String(e);
        }
      }

      return res.status(502).json({ error: 'AI 返回的方案不符合候选约束，请稍后重试' });
    }

    let finalPrompt = prompt;
    let allowedDishNames = null;
    const avoidSet = new Set(mergedAvoidList);
    finalPrompt += `\n\n【权威用户档案（服务器侧，来自登录用户云端档案；如与上文冲突以此为准）】\n${JSON.stringify(
      mergedProfile
    )}\n`;

    if (refreshMealKey && mealKeys.includes(refreshMealKey) && fixedMeals && typeof fixedMeals === 'object') {
      const others = mealKeys.filter((k) => k !== refreshMealKey);
      const fixedSnap = {};
      let snapOk = true;
      for (const k of others) {
        const fm = fixedMeals[k];
        if (!fm || typeof fm !== 'object') {
          snapOk = false;
          break;
        }
        fixedSnap[k] = {
          name: fm.name,
          calories: fm.calories,
          desc: fm.desc,
          category: fm.category,
          dishNames: fm.dishNames,
        };
      }
      if (snapOk) {
        finalPrompt += `\n\n【单餐更换】用户只想更换「${mealLabel[refreshMealKey]}」。以下餐次必须保持 name/calories/desc 与下面一致（逐字一致）：\n${JSON.stringify(
          fixedSnap
        )}\n请重新生成「${mealLabel[refreshMealKey]}」，并输出完整三餐 JSON（breakfast/lunch/dinner 三个键都要有）。\n`;
      }
    }

    const body = {
      model: doubaoModel,
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: finalPrompt,
            },
          ],
        },
      ],
    };
    const parsePlan = (data) => {
      const rawText = extractDoubaoText(data);
      const jsonStr = extractJsonFromText(rawText);
      try {
        return JSON.parse(jsonStr || '{}');
      } catch {
        return {};
      }
    };

    const containsAvoid = (name) => {
      const n = String(name || '').trim();
      if (!n) return false;
      if (avoidSet.size === 0) return false;
      if (avoidSet.has(n)) return true;
      // 兜底：避免“名称带后缀/组合名”绕过精确匹配
      for (const a of avoidSet) {
        if (a && n.includes(a)) return true;
      }
      return false;
    };

    const isValidPlan = (plan) => {
      const keys = ['breakfast', 'lunch', 'dinner'];
      for (const k of keys) {
        const item = plan?.[k];
        if (!item || typeof item !== 'object') return false;
        if (typeof item.name !== 'string' || !item.name.trim()) return false;
        if (containsAvoid(item.name)) return false;
        const cals = Number(item.calories);
        if (!Number.isFinite(cals) || cals <= 0) return false;
        if (typeof item.desc !== 'string' || !item.desc.trim()) return false;
        if (allowedDishNames && !allowedDishNames.has(item.name)) return false;
      }
      return true;
    };

    // 额外重试：解决“换一批只在两套方案间切换/忽略 avoidNames”
    let result = null;
    let lastText = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const extraRule = avoidSet.size
        ? `\n\n严格约束：不得使用/包含以下菜名（换一批去重）：${Array.from(avoidSet).join('、')}。`
        : '';
      const attemptBody =
        attempt === 0
          ? body
          : {
              ...body,
              input: [
                {
                  role: 'user',
                  content: [
                    {
                      type: 'input_text',
                      text:
                        `${finalPrompt}${extraRule}\n\n` +
                        `注意：你上一轮输出不符合要求（缺字段/非严格 JSON/菜名重复）。` +
                        `请严格修正后只输出 JSON。` +
                        (lastText ? `（上一轮原文片段：${String(lastText).slice(0, 120)}）` : ''),
                    },
                  ],
                },
              ],
            };
      const data = await callDoubaoWithJsonFormatFallback(attemptBody);
      lastText = extractDoubaoText(data) || '';
      const parsed = parsePlan(data);
      if (isValidPlan(parsed)) {
        result = parsed;
        break;
      }
    }

    if (!result || !isValidPlan(result)) {
      return res.status(502).json({ error: 'AI 返回的方案不符合要求，请点击“换一批推荐”重试' });
    }

    if (refreshMealKey && mealKeys.includes(refreshMealKey) && fixedMeals && typeof fixedMeals === 'object') {
      for (const k of mealKeys) {
        if (k === refreshMealKey) continue;
        const fm = fixedMeals[k];
        if (fm && typeof fm === 'object' && typeof fm.name === 'string' && fm.name.trim()) {
          result[k] = {
            name: String(fm.name),
            calories: Math.round(Number(fm.calories) || 0),
            desc: typeof fm.desc === 'string' ? fm.desc : '',
            category: fm.category,
            dishNames: Array.isArray(fm.dishNames) ? fm.dishNames.filter(Boolean) : undefined,
          };
        }
      }
      if (!isValidPlan(result)) {
        return res.status(502).json({ error: 'AI 返回的方案不符合要求，请点击“换一批推荐”重试' });
      }
    }

    res.json(result);
  } catch (err) {
    console.error('[api/ai/plan]', err);
    res.status(500).json({ error: err?.message || '生成失败' });
  }
});

/**
 * 解析 AI 专家对话意图（结构化 JSON）
 * 用于把“模糊自然语言”拆成可执行约束，再进入最终回答生成阶段。
 */
async function parseCoachIntent(message) {
  const body = {
    model: doubaoModel,
    text: { format: { type: 'json_object' } },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              '你是营养咨询意图解析器。请将用户输入解析成 JSON，不要输出任何解释。' +
              '返回结构：' +
              '{"intent":"diet_advice|meal_plan|food_choice|training_nutrition|health_condition|other",' +
              '"goal":"lose|gain|shape|maintain|unknown",' +
              '"mealTime":"breakfast|lunch|dinner|snack|all|unknown",' +
              '"constraints":["字符串数组"],' +
              '"needAskMore":true/false,' +
              '"ask":"若 needAskMore=true，给一句追问，否则空字符串"}。' +
              `用户输入：${String(message || '').trim()}`,
          },
        ],
      },
    ],
  };
  const data = await callDoubaoWithJsonFormatFallback(body);
  const rawText = extractDoubaoText(data);
  const jsonStr = extractJsonFromText(rawText);
  const parsed = JSON.parse(jsonStr || '{}');
  return {
    intent: typeof parsed.intent === 'string' ? parsed.intent : 'other',
    goal: typeof parsed.goal === 'string' ? parsed.goal : 'unknown',
    mealTime: typeof parsed.mealTime === 'string' ? parsed.mealTime : 'unknown',
    constraints: Array.isArray(parsed.constraints) ? parsed.constraints.map((x) => String(x)).filter(Boolean) : [],
    needAskMore: Boolean(parsed.needAskMore),
    ask: typeof parsed.ask === 'string' ? parsed.ask : '',
  };
}

// AI 对话：单轮，传入用户消息与系统指令
app.post('/api/ai/chat', async (req, res) => {
  if (!doubaoApiKey) {
    return res.status(503).json({ error: 'AI 服务未配置 DOUBAO_API_KEY' });
  }
  try {
    const { message, systemInstruction, profile } = req.body;
    if (!message) {
      return res.status(400).json({ error: '缺少 message' });
    }
    const mergedProfile = mergeProfiles(await loadUserProfileFromDb(req), profile);
    const sys =
      `${systemInstruction || '你是一位专业的AI营养专家。'}\n\n` +
      `【权威用户档案（服务器侧，来自登录用户云端档案；如与上文冲突以此为准）】\n${JSON.stringify(mergedProfile)}\n`;
    let parsedIntent = null;
    try {
      parsedIntent = await parseCoachIntent(message);
    } catch (e) {
      // 解析失败时自动回退到旧链路，不阻断主对话
      parsedIntent = null;
    }

    const intentBlock = parsedIntent
      ? [
          '',
          '【意图解析结果】',
          `intent=${parsedIntent.intent}`,
          `goal=${parsedIntent.goal}`,
          `mealTime=${parsedIntent.mealTime}`,
          `constraints=${parsedIntent.constraints.join('、') || '无'}`,
          parsedIntent.needAskMore && parsedIntent.ask ? `需要追问：${parsedIntent.ask}` : '需要追问：否',
          '请基于上述解析结果回答：',
          '- 若需要追问，先用一句简短问题澄清，再给一个保守可执行建议；',
          '- 若无需追问，直接给可执行建议（尽量量化，分点表达）。',
        ].join('\n')
      : '';

    const body = {
      model: doubaoModel,
      input: [
        {
          role: 'system',
          content: [
            { type: 'input_text', text: `${sys}${intentBlock}` },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: message },
          ],
        },
      ],
    };
    const data = await callDoubao(body);
    const text = extractDoubaoText(data) || '';
    res.json({
      text,
      parsedIntent: parsedIntent || undefined,
    });
  } catch (err) {
    console.error('[api/ai/chat]', err);
    res.status(500).json({ error: err?.message || '对话失败' });
  }
});

// 健康报告：基于用户档案生成可解释的饮食/作息/运动建议与目标
app.post('/api/ai/report', async (req, res) => {
  if (!doubaoApiKey) {
    return res.status(503).json({ error: 'AI 服务未配置 DOUBAO_API_KEY' });
  }
  try {
    const { profile, targets } = req.body || {};
    const mergedProfile = mergeProfiles(await loadUserProfileFromDb(req), profile);
    if (!mergedProfile || typeof mergedProfile !== 'object') {
      return res.status(400).json({ error: '缺少 profile（或未登录导致无法读取云端档案）' });
    }
    if (!targets || typeof targets !== 'object') {
      return res.status(400).json({ error: '缺少 targets' });
    }

    const prompt = `你是一位专业的营养与训练教练，请为用户生成“健康报告”。\n\n` +
      `【用户档案 profile】\n${JSON.stringify(mergedProfile)}\n\n` +
      `【目标摄入 targets】\n${JSON.stringify(targets)}\n\n` +
      `要求：\n` +
      `1) 报告必须可解释：明确说明“方案推荐”是基于哪些信息（目标、活动量、限制/忌口、健康状况等）。\n` +
      `2) 给出可量化的日目标：热量/蛋白质/碳水/脂肪/饮水（ml）/睡眠（小时）/步数（可选）。\n` +
      `3) 给出可执行建议：饮食结构（怎么吃、怎么选）、作息（睡前/起床建议）、运动（频次/时长/强度、训练与恢复）。\n` +
      `4) 避免医疗诊断，用“建议/可能/请咨询专业人士”表述。\n` +
      `5) reportMarkdown 必须是 Markdown，并遵守以下结构（用标题分段，便于前端做精美渲染）：\n` +
      `   - # 健康报告\n` +
      `   - ## 摘要（3-5条要点，使用无序列表）\n` +
      `   - ## 目标与依据（解释为什么这样推荐，列出影响因素）\n` +
      `   - ## 每日目标（列出热量/三大营养素/饮水/睡眠/步数，使用列表）\n` +
      `   - ## 饮食策略（怎么吃、怎么选、外食策略、示例搭配）\n` +
      `   - ## 作息建议（起床/睡前/餐次安排）\n` +
      `   - ## 运动建议（训练日/休息日、强度、恢复）\n` +
      `   - ## 注意事项与免责声明\n` +
      `6) 输出严格 JSON，不要 Markdown 代码块，不要多余文字。\n\n` +
      `返回 JSON 结构：{\n` +
      `  "targets": {"calories":number,"protein":number,"carbs":number,"fat":number,"waterMl":number,"sleepHours":number,"steps":number},\n` +
      `  "reportMarkdown": "一段 Markdown 报告，包含：摘要、目标解释、饮食建议、作息建议、运动建议、注意事项与免责声明"\n` +
      `}\n`;

    const buildFallback = (p, t, reason) => {
      const goal = p?.goal || 'maintain';
      const goalLabel = goal === 'lose' ? '减脂' : goal === 'gain' ? '增肌' : goal === 'shape' ? '塑形' : '维持';
      const activity = p?.activityLevel || 'moderate';
      const restrictions = Array.isArray(p?.dietaryRestrictions) ? p.dietaryRestrictions.filter(Boolean) : [];
      const health = Array.isArray(p?.healthConditions) ? p.healthConditions.filter(Boolean) : [];
      const lines = [
        `# 你的健康报告（基础版）`,
        ``,
        `> 说明：本次豆包生成失败（${reason || '未知原因'}），已先根据你填写的信息生成可执行的基础报告。`,
        ``,
        `## 1. 目标与依据`,
        `- 目标：**${goalLabel}**`,
        `- 活动量：**${activity}**，每周训练 **${p?.trainingDays ?? 0}** 天（${p?.trainingType || 'mixed'}）`,
        restrictions.length ? `- 饮食限制：${restrictions.join('、')}` : `- 饮食限制：无`,
        health.length ? `- 健康状况：${health.join('、')}` : `- 健康状况：无`,
        ``,
        `## 2. 你的每日目标（建议值）`,
        `- 热量：**${Number(t?.calories) || 0} kcal**`,
        `- 蛋白质：**${Number(t?.protein) || 0} g**`,
        `- 碳水：**${Number(t?.carbs) || 0} g**`,
        `- 脂肪：**${Number(t?.fat) || 0} g**`,
        `- 饮水：建议 **1800-2500 ml/天**（按出汗量上下浮动）`,
        `- 睡眠：建议 **7-9 小时/天**`,
        ``,
        `## 3. 饮食怎么吃（可执行）`,
        `- 每餐优先：**1份优质蛋白 + 1-2份蔬菜 + 1份主食**（减脂可适当减少主食量）`,
        `- 蛋白来源：鸡蛋、鱼虾、瘦肉、豆制品、奶类；尽量避免“全靠油炸/高糖饮料”`,
        `- 外食/食堂选菜：优先“清蒸/水煮/少油炒”，少选“红烧肥肉/重油重盐/甜口浇汁”`,
        ``,
        `## 4. 作息怎么做`,
        `- 尽量固定入睡与起床时间；睡前 1 小时减少咖啡因与高强度刷屏`,
        `- 如果晚餐较晚：减少油脂与夜宵，给消化留时间`,
        ``,
        `## 5. 运动怎么安排`,
        `- 每周 ${p?.trainingDays ?? 3} 天训练：力量优先（增肌/塑形），减脂可叠加 2-3 次中低强度有氧（20-40 分钟）`,
        `- 训练日：主食可比休息日略多；非训练日：增加蔬菜与蛋白，控制高油高糖`,
        ``,
        `## 6. 注意事项`,
        `- 本报告为建议，不构成医疗诊断；如有慢病或不适请咨询医生/营养师。`,
      ];
      return lines.join('\n');
    };

    const body = {
      model: doubaoModel,
      text: { format: { type: 'json_object' } },
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: prompt }],
        },
      ],
    };

    try {
      const data = await callDoubaoWithJsonFormatFallback(body);
      const rawText = extractDoubaoText(data);
      const jsonStr = extractJsonFromText(rawText);
      let parsed;
      try {
        parsed = JSON.parse(jsonStr || '{}');
      } catch {
        parsed = {};
      }

      const reportMarkdown = typeof parsed?.reportMarkdown === 'string' ? parsed.reportMarkdown : '';
      const outTargets = parsed?.targets && typeof parsed.targets === 'object' ? parsed.targets : {};
      if (!reportMarkdown) {
        throw new Error('AI 未生成健康报告内容');
      }

      return res.json({
        aiOk: true,
        generatedAt: new Date().toISOString(),
        reportMarkdown,
        targets: outTargets,
      });
    } catch (e) {
      return res.json({
        aiOk: false,
        generatedAt: new Date().toISOString(),
        reportMarkdown: buildFallback(mergedProfile, targets, e?.message || '调用失败'),
        targets,
      });
    }
  } catch (err) {
    console.error('[api/ai/report]', err);
    res.status(500).json({ error: err?.message || '生成失败' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `[recipe-api] 监听 0.0.0.0:${PORT} | NODE_ENV=${process.env.NODE_ENV || '(未设置)'} | 调试路由=${debugRoutes ? '开' : '关'}`
  );
});
