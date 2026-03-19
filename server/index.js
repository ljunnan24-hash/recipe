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

// 豆包（火山方舟）配置
const doubaoEndpoint = process.env.DOUBAO_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/responses';
const doubaoApiKey = process.env.DOUBAO_API_KEY;
const doubaoModel = process.env.DOUBAO_MODEL || 'doubao-seed-2-0-mini-260215';
// 识图需使用支持视觉的模型，未配置时用通用模型（部分种子模型不支持图片）
const doubaoVisionModel = process.env.DOUBAO_VISION_MODEL || doubaoModel;

const supabaseUrl = process.env.SUPABASE_URL || 'https://hqwonhdrgqlasbvkicmu.supabase.co';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!doubaoApiKey) {
  console.warn('警告: 未设置 DOUBAO_API_KEY，AI 相关接口将返回 503。请在 .env 或 .env.local 中配置。');
}
if (!supabaseAnonKey) {
  console.warn('警告: 未设置 SUPABASE_ANON_KEY，深大食堂方案将无法从数据库拉取菜品，仍使用通用描述。');
}

function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.SUPABASE_TIMEOUT_MS) || 6000;
  const t = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

const supabase = supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: fetchWithTimeout } })
  : null;

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
    .select('name, calories, protein, carbs, fat, category, description')
    .eq('canteen_key', canteenKey)
    .order('category');

  if (!e1) return d1 || [];

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
  return (d2 || []).map((r) => ({
    name: r.dish_name,
    calories: Number(r.calories) || 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    category: r.category || 'lunch',
    description: r.remark || '',
  }));
}

function planFromCanteenDishes(dishes, profile, targets, avoidNames) {
  const goal = profile?.goal || 'maintain';
  const targetCalories = Number(targets?.calories) || 1800;

  const avoid = new Set((Array.isArray(avoidNames) ? avoidNames : []).filter(Boolean));

  // 有些数据库只有“菜品分类”而非三餐分类（如：热菜/小炒/主食），这里不强依赖 category=breakfast/lunch/dinner
  const allDishes = (dishes || []).slice();
  const hasMacros = allDishes.some((d) => (Number(d?.protein) || 0) > 0 || (Number(d?.carbs) || 0) > 0 || (Number(d?.fat) || 0) > 0);

  const normalizeTokens = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).flatMap((s) => normalizeTokens(s));
    return String(value)
      .split(/[\s,，、;；/|]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const hatedTokens = normalizeTokens(profile?.hatedIngredients);
  const restrictionsTokens = normalizeTokens(profile?.dietaryRestrictions);
  const healthTokens = normalizeTokens(profile?.healthConditions);

  const containsAny = (haystack, tokens) => {
    if (!haystack) return false;
    for (const t of tokens || []) {
      if (t && haystack.includes(t)) return true;
    }
    return false;
  };

  const isVegetarian = restrictionsTokens.some((t) => /素|素食|vege/i.test(t));
  const meatKeywords = ['猪', '牛', '羊', '鸡', '鸭', '鱼', '虾', '蟹', '肉', '培根', '香肠', '火腿'];
  const stapleKeywords = ['米饭', '面', '粥', '粉', '馒头', '包子', '面包', '油条', '饼', '饭', '面条'];
  // 更偏“面/面食”的关键词（避免误命中“面包”里的“面”）
  const noodleKeywords = ['面条', '炒面', '拉面', '乌冬', '意面', '米粉', '米线', '粉丝'];
  // 更偏“米饭/米粥”的关键词
  const riceKeywords = ['米饭', '炒饭', '盖饭', '粥', '米粥'];
  const sugaryKeywords = ['奶茶', '可乐', '汽水', '蛋糕', '甜品', '糖', '巧克力', '饼干', '冰淇淋'];

  const isStaple = (dish) => containsAny(`${dish?.name || ''} ${dish?.description || ''}`, stapleKeywords);
  const isNoodle = (dish) => containsAny(`${dish?.name || ''} ${dish?.description || ''}`, noodleKeywords);
  const isRice = (dish) => containsAny(`${dish?.name || ''} ${dish?.description || ''}`, riceKeywords);
  const isSugary = (dish) => containsAny(`${dish?.name || ''} ${dish?.description || ''}`, sugaryKeywords);

  const isDishAllowed = (dish) => {
    const text = `${dish?.name || ''} ${dish?.description || ''}`;
    if (containsAny(text, hatedTokens)) return false;
    if (isVegetarian && containsAny(text, meatKeywords)) return false;
    // 减脂时尽量避免高糖饮料/甜品类
    if (goal === 'lose' && isSugary(dish)) return false;
    return true;
  };

  const scoreDish = (d) => {
    const calories = Number(d.calories) || 0;
    const protein = Number(d.protein) || 0;
    const fat = Number(d.fat) || 0;
    const carbs = Number(d.carbs) || 0;
    const proteinDensity = calories > 0 ? protein / calories : 0;

    const hasDiabetes = healthTokens.some((t) => /糖尿病|血糖/i.test(t));
    const hasHighLipids = healthTokens.some((t) => /高血脂|胆固醇/i.test(t));
    const hasHypertension = healthTokens.some((t) => /高血压/i.test(t));

    // 健康状态惩罚项（数据库无钠信息，轻量处理）
    const healthPenalty =
      (hasDiabetes ? carbs * 0.06 : 0) +
      (hasHighLipids ? fat * 0.18 : 0) +
      (hasHypertension ? fat * 0.05 : 0);

    if (goal === 'lose') return proteinDensity * 120 - calories * 0.01 - fat * 0.15;
    if (goal === 'gain') return proteinDensity * 80 + calories * 0.004 + protein * 0.25 - healthPenalty;
    if (goal === 'shape') return proteinDensity * 100 - fat * 0.1 + carbs * 0.02 - calories * 0.004 - healthPenalty;
    return proteinDensity * 90 - calories * 0.006 - fat * 0.08 - healthPenalty;
  };

  const mealBudget = (mealKey) => mealKey === 'breakfast'
    ? targetCalories * 0.25
    : mealKey === 'lunch'
      ? targetCalories * 0.4
      : targetCalories * 0.35;

  const pickCombo = (mealKey) => {
    const budget = mealBudget(mealKey);
    let candidates = allDishes
      .filter((d) => d?.name && !avoid.has(d.name) && isDishAllowed(d))
      .map((d) => ({ ...d, _cal: Number(d.calories) || 0 }))
      .filter((d) => d._cal > 0);

    // 早餐/午餐/晚餐：优先从对应 category 的菜里挑
    // 若数据库中该餐段 category 的菜不足，则退回到全量候选，并对“早餐”做额外启发式兜底
    const mealCategoryCandidates = candidates.filter((d) => d.category === mealKey);
    if (mealCategoryCandidates.length) {
      candidates = mealCategoryCandidates;
    } else if (mealKey === 'breakfast') {
      // 早餐启发式：优先挑更像“早餐”的名字/描述（当数据库没有严格区分餐段时）
      const breakfastKeywords = ['粥', '馒头', '包子', '豆浆', '油条', '鸡蛋饼', '面包', '三明治', '麦片', '皮蛋瘦肉粥', '豆浆+油条'];
      const breakfastHeuristic = candidates.filter((d) => containsAny(`${d?.name || ''} ${d?.description || ''}`, breakfastKeywords));
      if (breakfastHeuristic.length) candidates = breakfastHeuristic;
    }

    if (!candidates.length) return null;

    // 有宏量数据时才按目标评分；否则按热量贴近度来选，避免“全选最低热量”
    if (hasMacros) {
      candidates.sort((a, b) => scoreDish(b) - scoreDish(a));
    }

    const chosen = [];
    let total = 0;

    // 优先选一份主菜
    const primaryPool = hasMacros ? candidates.slice(0, Math.min(25, candidates.length)) : candidates.slice(0, Math.min(120, candidates.length));
    // 减脂也要保证方案可执行，主菜尽量占到单餐预算的一半左右，避免出现“全是 40kcal 青菜”
    const primaryTarget = budget * 0.55;
    let primary = primaryPool[0];
    let bestDist = Math.abs(primary._cal - primaryTarget);
    for (const d of primaryPool) {
      const dist = Math.abs(d._cal - primaryTarget);
      if (dist < bestDist) {
        bestDist = dist;
        primary = d;
      }
    }
    chosen.push(primary);
    total += primary._cal;
    avoid.add(primary.name);

    // 如果减脂，主食更克制；增肌/维持可更容易补主食凑热量
    const wantStaple = goal !== 'lose';

    const tryAdd = (filterFn) => {
      const remain = Math.max(0, budget - total);
      const local = candidates
        .filter((d) => !avoid.has(d.name) && filterFn(d))
        .slice()
        .sort((a, b) => hasMacros ? (scoreDish(b) - scoreDish(a)) : 0);
      if (!local.length) return false;
      // 在候选里选一个更接近单餐预算的（无宏量数据时更依赖热量贴近度）
      const top = hasMacros ? local.slice(0, Math.min(12, local.length)) : local.slice(0, Math.min(80, local.length));
      let best = null;
      let bestDist = Infinity;
      for (const d of top) {
        const dist = Math.abs((total + d._cal) - budget);
        if (dist < bestDist) {
          bestDist = dist;
          best = d;
        }
      }
      if (!best) return false;
      chosen.push(best);
      total += best._cal;
      avoid.add(best.name);
      return true;
    };

    // 第二道：尽量让总热量贴近预算；优先非主食
    tryAdd((d) => !isStaple(d));

    // 第三道：如果还差很多，增肌/维持优先补主食，减脂则优先补低能量的菜
    const lowGap = total < budget * 0.85;
    if (lowGap) {
      if (wantStaple) {
        tryAdd((d) => isStaple(d));
      } else {
        // 减脂依然需要接近目标热量；若差太多，允许选择小份主食（如米饭/粥/饼）补足
        const added = tryAdd((d) => !isStaple(d) && d._cal <= 220);
        if (!added && total < budget * 0.7) {
          tryAdd((d) => isStaple(d) && d._cal <= 260);
        }
      }
    }

    // 若仍偏离，允许再补 1 道（最多 4 道），但不要离谱
    if (chosen.length < 4 && Math.abs(total - budget) > budget * 0.25) {
      tryAdd(() => true);
    }

    // 午餐/晚餐强制有主食：
    // - 若已经有“面”（noodle），可不补米饭
    // - 若没有面：必须补“米饭/粥”（rice），并计入热量（total 会更新）
    if (mealKey === 'lunch' || mealKey === 'dinner') {
      const hasNoodle = chosen.some((d) => isNoodle(d));
      const hasRice = chosen.some((d) => isRice(d));

      if (!hasNoodle && !hasRice) {
        if (chosen.length < 5) {
          const addedRice = tryAdd((d) => isRice(d));
          // 如果没找到 rice 关键词菜，则退化为任意主食
          if (!addedRice) {
            tryAdd((d) => isStaple(d));
          }
        } else if (chosen.length >= 5) {
          // chosen 已经很满时，用“替换”方式塞入米饭（尽量贴近预算）
          const riceCandidates = candidates.filter((d) => !avoid.has(d.name) && isRice(d));
          const stapleCandidates = candidates.filter((d) => !avoid.has(d.name) && isStaple(d));
          const pool = riceCandidates.length ? riceCandidates : stapleCandidates;
          if (pool.length) {
            // 取一小段候选即可（避免 O(n^2) 太大）
            const topPool = hasMacros ? pool.slice().sort((a, b) => scoreDish(b) - scoreDish(a)).slice(0, 10) : pool.slice(0, 10);
            let best = null;
            let bestIdx = -1;
            let bestDist = Infinity;
            for (const rc of topPool) {
              for (let i = 0; i < chosen.length; i++) {
                const newTotal = total - chosen[i]._cal + rc._cal;
                const dist = Math.abs(newTotal - budget);
                if (dist < bestDist) {
                  bestDist = dist;
                  best = rc;
                  bestIdx = i;
                }
              }
            }
            if (best && bestIdx >= 0) {
              total = total - chosen[bestIdx]._cal + best._cal;
              chosen[bestIdx] = best;
            }
          }
        }
      }
    }

    const goalLabel = goal === 'lose' ? '减脂' : goal === 'gain' ? '增肌' : goal === 'shape' ? '塑形' : '维持';
    const name = chosen.map((c) => c.name).join(' + ');
    const descParts = chosen.map((c) => {
      const detail = `${c.name}（${Number(c.calories) || 0}kcal）${c.description ? `：${c.description}` : ''}`;
      return detail;
    });
    const dishNames = chosen.map((c) => c.name).filter(Boolean);
    // 返回“真实的 category 字段”（用于右上角显示“窗口/类别”）
    const category = chosen?.[0]?.category || mealKey;
    return {
      name,
      calories: Math.round(total),
      desc: `按目标：${goalLabel}。包含：${descParts.join('；')}`,
      category,
      // 用于“换一批推荐”的去重：存储组成该餐的真实菜品名
      dishNames,
    };
  };

  const breakfast = pickCombo('breakfast');
  const lunch = pickCombo('lunch');
  const dinner = pickCombo('dinner');
  if (!breakfast || !lunch || !dinner) return null;

  return { breakfast, lunch, dinner };
}

// base64 图片会比原图体积大不少，10mb 容易在手机拍照时触顶导致识别失败
app.use(express.json({ limit: '25mb' }));

// 健康检查
app.get('/api/health', (_, res) => {
  res.json({ ok: true, service: 'recipe-api' });
});

// 豆包连通性测试：浏览器访问 /api/test-doubao 即可验证 Key 和接口是否正常
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

// Supabase 连通性测试（用于排查“数据库无菜品”究竟是空表还是连不上）
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
  if (!doubaoApiKey) {
    return res.status(503).json({ error: 'AI 服务未配置 DOUBAO_API_KEY' });
  }
  try {
    const { prompt, selectedCanteen, profile, targets, avoidNames } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: '缺少 prompt' });
    }
    if (selectedCanteen === 'szu_south' && !supabase) {
      return res.status(503).json({ error: '未配置 SUPABASE_ANON_KEY，无法从深大食堂数据库挑选菜品' });
    }

    // 深大食堂：直接从 Supabase 菜谱中按目标挑选，确保推荐菜名来自数据库
    if (selectedCanteen === 'szu_south') {
      let dishes;
      try {
        dishes = await getCanteenDishes('szu_south');
      } catch (e) {
        return res.status(502).json({ error: e?.message || '无法连接食堂数据库' });
      }
      if (!dishes.length) {
        return res.status(503).json({ error: '深大食堂数据库暂无菜品数据（canteen_dishes 为空）' });
      }
      const planned = planFromCanteenDishes(dishes, profile, targets, avoidNames);
      if (!planned) {
        return res.status(502).json({ error: '无法从数据库菜谱中生成方案，请补充菜谱数据后重试' });
      }
      return res.json(planned);
    }

    let finalPrompt = prompt;
    let allowedDishNames = null;
    if (selectedCanteen === 'szu_south' && supabase) {
      const dishes = await getCanteenDishes('szu_south');
      if (!dishes.length) {
        return res.status(503).json({ error: '深大食堂数据库暂无菜品数据（canteen_dishes 为空）' });
      }
      allowedDishNames = new Set(dishes.map((d) => d.name).filter(Boolean));
      if (dishes.length > 0) {
        const byCategory = { breakfast: [], lunch: [], dinner: [], snack: [] };
        dishes.forEach((d) => {
          if (byCategory[d.category]) byCategory[d.category].push(d);
          else byCategory.lunch.push(d);
        });
        const lines = [];
        ['breakfast', 'lunch', 'dinner'].forEach((cat) => {
          const list = byCategory[cat];
          if (list && list.length) {
            const label = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' }[cat];
            lines.push(`${label}可选菜品（仅从以下挑选，并严格使用表中的热量与营养数据）：`);
            list.forEach((d) => {
              lines.push(`- ${d.name}：${d.calories}kcal，蛋白质${d.protein}g，碳水${d.carbs}g，脂肪${d.fat}g${d.description ? `（${d.description}）` : ''}`);
            });
          }
        });
        const dishBlock = lines.length
          ? `\n\n【深大南区食堂当前菜单与营养数据】\n${lines.join('\n')}\n\n请仅从以上菜品中为用户搭配三餐，返回的 name 必须与上表一致，calories 必须使用表中数值。\n\n`
          : '';
        finalPrompt = dishBlock + prompt;
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

    const isValidPlan = (plan) => {
      const keys = ['breakfast', 'lunch', 'dinner'];
      for (const k of keys) {
        const item = plan?.[k];
        if (!item || typeof item !== 'object') return false;
        if (typeof item.name !== 'string' || !item.name.trim()) return false;
        const cals = Number(item.calories);
        if (!Number.isFinite(cals) || cals <= 0) return false;
        if (typeof item.desc !== 'string' || !item.desc.trim()) return false;
        if (allowedDishNames && !allowedDishNames.has(item.name)) return false;
      }
      return true;
    };

    let data = await callDoubaoWithJsonFormatFallback(body);
    let result = parsePlan(data);

    if (!isValidPlan(result)) {
      // 轻量重试一次：常见原因是模型没按菜单选、或漏字段
      const retryBody = {
        ...body,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `${finalPrompt}\n\n注意：你上一轮输出不符合要求（缺字段/非严格 JSON/菜名不在列表）。请严格修正后只输出 JSON。`,
              },
            ],
          },
        ],
      };
      data = await callDoubaoWithJsonFormatFallback(retryBody);
      result = parsePlan(data);
    }

    if (!isValidPlan(result)) {
      return res.status(502).json({ error: 'AI 返回的方案不符合要求，请点击“换一批推荐”重试' });
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
    const { message, systemInstruction } = req.body;
    if (!message) {
      return res.status(400).json({ error: '缺少 message' });
    }
    const sys = systemInstruction || '你是一位专业的AI营养专家。';
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
    if (!profile || typeof profile !== 'object') {
      return res.status(400).json({ error: '缺少 profile' });
    }
    if (!targets || typeof targets !== 'object') {
      return res.status(400).json({ error: '缺少 targets' });
    }

    const prompt = `你是一位专业的营养与训练教练，请为用户生成“健康报告”。\n\n` +
      `【用户档案 profile】\n${JSON.stringify(profile)}\n\n` +
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
        reportMarkdown: buildFallback(profile, targets, e?.message || '调用失败'),
        targets,
      });
    }
  } catch (err) {
    console.error('[api/ai/report]', err);
    res.status(500).json({ error: err?.message || '生成失败' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Recipe API 运行在 http://localhost:${PORT}`);
});
