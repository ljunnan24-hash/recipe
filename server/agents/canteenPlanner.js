/**
 * 食堂配餐智能体（Canteen / Meal composition）
 * 从数据库菜品中按目标热量与约束组合三餐；支持仅替换某一餐。
 */

const MEAL_KEYS = ['breakfast', 'lunch', 'dinner'];

/**
 * 在距目标最近的一批候选中随机取一项，避免热量距离相同或极接近时算法完全确定，
 * 导致「换一批」总在两套组合间来回切换。
 * @param {unknown[]} items
 * @param {(d: unknown) => number} distFn
 * @param {{ maxTies?: number, relEps?: number, absFloor?: number }} [options]
 */
function pickByClosestRandom(items, distFn, options = {}) {
  const { maxTies = 14, relEps = 0.06, absFloor = 8 } = options;
  if (!items?.length) return null;
  const scored = items.map((d) => ({ d, dist: distFn(d) }));
  scored.sort((a, b) => a.dist - b.dist);
  const bestDist = scored[0].dist;
  const threshold = bestDist + Math.max(bestDist * relEps, absFloor);
  const ties = scored.filter((x) => x.dist <= threshold).slice(0, maxTies);
  return ties[Math.floor(Math.random() * ties.length)].d;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function normalizeFixedMeal(fm, fallbackKey) {
  if (!fm || typeof fm !== 'object') return null;
  const name = typeof fm.name === 'string' ? fm.name.trim() : '';
  const cals = Number(fm.calories);
  const desc = typeof fm.desc === 'string' ? fm.desc : '';
  if (!name || !Number.isFinite(cals) || cals <= 0) return null;
  return {
    name,
    calories: Math.round(cals),
    desc,
    category: typeof fm.category === 'string' ? fm.category : fallbackKey,
    dishNames: Array.isArray(fm.dishNames) ? fm.dishNames.map((x) => String(x || '').trim()).filter(Boolean) : undefined,
  };
}

/**
 * @param {unknown[]} dishes
 * @param {object} profile
 * @param {{ calories?: number }} targets
 * @param {unknown} avoidNames
 * @param {{ refreshMealKey?: 'breakfast'|'lunch'|'dinner', fixedMeals?: Record<string, unknown> }} [opts]
 */
export function planFromCanteenDishes(dishes, profile, targets, avoidNames, opts = {}) {
  const refreshMealKey = opts.refreshMealKey;
  const fixedMeals = opts.fixedMeals && typeof opts.fixedMeals === 'object' ? opts.fixedMeals : null;

  const goal = profile?.goal || 'maintain';
  const targetCalories = Number(targets?.calories) || 1800;

  const avoid = new Set(
    (Array.isArray(avoidNames) ? avoidNames : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  );

  const addFixedMealDishesToAvoid = () => {
    if (!fixedMeals || !refreshMealKey) return;
    for (const k of MEAL_KEYS) {
      if (k === refreshMealKey) continue;
      const fm = fixedMeals[k];
      if (!fm || typeof fm !== 'object') continue;
      const dm = fm.dishNames;
      if (Array.isArray(dm) && dm.length) {
        dm.forEach((n) => {
          const t = String(n || '').trim();
          if (t) avoid.add(t);
        });
      } else if (typeof fm.name === 'string' && fm.name.trim()) {
        avoid.add(fm.name.trim());
      }
    }
  };
  addFixedMealDishesToAvoid();

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
  const noodleKeywords = ['面条', '炒面', '拉面', '乌冬', '意面', '米粉', '米线', '粉丝'];
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

    const mealCategoryCandidates = candidates.filter((d) => d.category === mealKey);
    if (mealCategoryCandidates.length) {
      candidates = mealCategoryCandidates;
    } else if (mealKey === 'breakfast') {
      const breakfastKeywords = ['粥', '馒头', '包子', '豆浆', '油条', '鸡蛋饼', '面包', '三明治', '麦片', '皮蛋瘦肉粥', '豆浆+油条'];
      const breakfastHeuristic = candidates.filter((d) => containsAny(`${d?.name || ''} ${d?.description || ''}`, breakfastKeywords));
      if (breakfastHeuristic.length) candidates = breakfastHeuristic;
    }

    if (!candidates.length) return null;

    if (hasMacros) {
      candidates.sort((a, b) => scoreDish(b) - scoreDish(a));
    } else {
      shuffleInPlace(candidates);
    }

    const chosen = [];
    let total = 0;

    const primaryPool = hasMacros ? candidates.slice(0, Math.min(25, candidates.length)) : candidates.slice(0, Math.min(120, candidates.length));
    const primaryTarget = budget * 0.55;
    const primary = pickByClosestRandom(
      primaryPool,
      (d) => Math.abs(d._cal - primaryTarget),
      { maxTies: 16, relEps: 0.05, absFloor: 10 }
    );
    if (!primary) return null;
    chosen.push(primary);
    total += primary._cal;
    avoid.add(primary.name);

    const wantStaple = goal !== 'lose';

    const tryAdd = (filterFn) => {
      const local = candidates
        .filter((d) => !avoid.has(d.name) && filterFn(d))
        .slice()
        .sort((a, b) => hasMacros ? (scoreDish(b) - scoreDish(a)) : 0);
      if (!local.length) return false;
      const top = hasMacros ? local.slice(0, Math.min(12, local.length)) : local.slice(0, Math.min(80, local.length));
      const best = pickByClosestRandom(
        top,
        (d) => Math.abs((total + d._cal) - budget),
        { maxTies: 14, relEps: 0.06, absFloor: 8 }
      );
      if (!best) return false;
      chosen.push(best);
      total += best._cal;
      avoid.add(best.name);
      return true;
    };

    tryAdd((d) => !isStaple(d));

    const lowGap = total < budget * 0.85;
    if (lowGap) {
      if (wantStaple) {
        tryAdd((d) => isStaple(d));
      } else {
        const added = tryAdd((d) => !isStaple(d) && d._cal <= 220);
        if (!added && total < budget * 0.7) {
          tryAdd((d) => isStaple(d) && d._cal <= 260);
        }
      }
    }

    if (chosen.length < 4 && Math.abs(total - budget) > budget * 0.25) {
      tryAdd(() => true);
    }

    if (mealKey === 'lunch' || mealKey === 'dinner') {
      const hasNoodle = chosen.some((d) => isNoodle(d));
      const hasRice = chosen.some((d) => isRice(d));

      if (!hasNoodle && !hasRice) {
        if (chosen.length < 5) {
          const addedRice = tryAdd((d) => isRice(d));
          if (!addedRice) {
            tryAdd((d) => isStaple(d));
          }
        } else if (chosen.length >= 5) {
          const riceCandidates = candidates.filter((d) => !avoid.has(d.name) && isRice(d));
          const stapleCandidates = candidates.filter((d) => !avoid.has(d.name) && isStaple(d));
          const pool = riceCandidates.length ? riceCandidates : stapleCandidates;
          if (pool.length) {
            const topPool = hasMacros ? pool.slice().sort((a, b) => scoreDish(b) - scoreDish(a)).slice(0, 10) : shuffleInPlace(pool.slice()).slice(0, 10);
            /** @type {{ rc: typeof pool[0], i: number, dist: number }[]} */
            const pairScores = [];
            for (const rc of topPool) {
              for (let i = 0; i < chosen.length; i++) {
                const newTotal = total - chosen[i]._cal + rc._cal;
                pairScores.push({ rc, i, dist: Math.abs(newTotal - budget) });
              }
            }
            pairScores.sort((a, b) => a.dist - b.dist);
            if (pairScores.length) {
              const bestDist3 = pairScores[0].dist;
              const threshold = bestDist3 + Math.max(bestDist3 * 0.06, 8);
              const ties = pairScores.filter((p) => p.dist <= threshold).slice(0, 24);
              const pick = ties[Math.floor(Math.random() * ties.length)];
              if (pick) {
                total = total - chosen[pick.i]._cal + pick.rc._cal;
                chosen[pick.i] = pick.rc;
              }
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
    const category = chosen?.[0]?.category || mealKey;
    return {
      name,
      calories: Math.round(total),
      desc: `按目标：${goalLabel}。包含：${descParts.join('；')}`,
      category,
      dishNames,
    };
  };

  if (refreshMealKey && MEAL_KEYS.includes(refreshMealKey)) {
    const out = {};
    for (const k of MEAL_KEYS) {
      if (k === refreshMealKey) {
        const m = pickCombo(refreshMealKey);
        if (!m) return null;
        out[k] = m;
      } else {
        const fixed = normalizeFixedMeal(fixedMeals?.[k], k);
        if (!fixed) return null;
        out[k] = fixed;
      }
    }
    return out;
  }

  const breakfast = pickCombo('breakfast');
  const lunch = pickCombo('lunch');
  const dinner = pickCombo('dinner');
  if (!breakfast || !lunch || !dinner) return null;

  return { breakfast, lunch, dinner };
}
