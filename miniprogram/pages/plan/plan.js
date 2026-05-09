const { aiPlan } = require('../../utils/api.js')
const { getJSON, KEYS, setJSON } = require('../../utils/storage.js')

function mergeDeclinedDishNames(prev, names) {
  const s = new Set()
  ;(prev || []).forEach((x) => {
    const t = String(x || '').trim()
    if (t) s.add(t)
  })
  ;(names || []).forEach((x) => {
    const t = String(x || '').trim()
    if (t) s.add(t)
  })
  return Array.from(s).slice(-60)
}

function collectDishNamesFromMeal(meal) {
  if (!meal) return []
  if (Array.isArray(meal.dishNames) && meal.dishNames.length) {
    return meal.dishNames.map((x) => String(x || '').trim()).filter(Boolean)
  }
  if (meal.name) return [String(meal.name).trim()].filter(Boolean)
  return []
}

function appendMealRefreshHistory(prev, entry) {
  return [...(prev || []), entry].slice(-100)
}

function bumpDeclinedStats(prev, names) {
  const out = { ...(prev || {}) }
  for (const n of names || []) {
    const k = String(n || '').trim()
    if (!k) continue
    out[k] = (out[k] || 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 80))
}

function buildPlanPrompt(profile) {
  const profileJson = JSON.stringify(profile || {})
  return (
    '你是配餐规划助手。请严格只输出 JSON（不要 Markdown，不要解释文字）。\n' +
    '输出必须符合下面结构（字段名必须一致，calories 必须为正数）：\n' +
    '{\n' +
    '  "breakfast": { "name": "字符串", "calories": 350, "desc": "字符串" },\n' +
    '  "lunch": { "name": "字符串", "calories": 650, "desc": "字符串" },\n' +
    '  "dinner": { "name": "字符串", "calories": 550, "desc": "字符串" }\n' +
    '}\n' +
    '约束：早餐更像早餐；午/晚餐必须包含主食（米饭/面/杂粮等）；每餐描述一句话即可。\n' +
    `用户档案 JSON：${profileJson}\n`
  )
}

Page({
  data: {
    loading: false,
    err: '',
    result: null,
    retryCount: 0
  },
  async onTryPlan(e) {
    const mealKey = e?.currentTarget?.dataset?.meal
    const prev = this.data.result
    const isRefresh = Boolean(prev)
    const isSingle = mealKey === 'breakfast' || mealKey === 'lunch' || mealKey === 'dinner'

    this.setData({ loading: true, err: '', retryCount: 0 })
    try {
      let profile = getJSON(KEYS.profile, null) || {}
      const selectedCanteen = getJSON(KEYS.selectedCanteen, 'none')
      if (isRefresh && prev) {
        const keys = isSingle ? [mealKey] : ['breakfast', 'lunch', 'dinner']
        const namesToDecline = keys.flatMap((k) => collectDishNamesFromMeal(prev[k]))
        const scope = isSingle ? mealKey : 'all'
        const logEntry = {
          ts: Date.now(),
          scope,
          dishNames: namesToDecline,
          selectedCanteen,
          mealTitles: {
            breakfast: prev.breakfast && prev.breakfast.name,
            lunch: prev.lunch && prev.lunch.name,
            dinner: prev.dinner && prev.dinner.name
          }
        }
        profile = {
          ...profile,
          declinedDishNames: mergeDeclinedDishNames(profile.declinedDishNames, namesToDecline),
          mealRefreshHistory: appendMealRefreshHistory(profile.mealRefreshHistory, logEntry),
          declinedDishStats: bumpDeclinedStats(profile.declinedDishStats, namesToDecline)
        }
        setJSON(KEYS.profile, profile)
      }

      const avoidFromCurrent =
        isRefresh && prev
          ? isSingle
            ? collectDishNamesFromMeal(prev[mealKey])
            : ['breakfast', 'lunch', 'dinner'].flatMap((k) => collectDishNamesFromMeal(prev[k]))
          : []

      const persistedAvoid = (profile.declinedDishNames || []).slice(-40)
      const mergedAvoid = [...new Set([...avoidFromCurrent, ...persistedAvoid])]

      const prompt = buildPlanPrompt(profile)

      const extra = {
        profile,
        avoidNames: mergedAvoid,
        refreshMealKey: isRefresh && isSingle ? mealKey : undefined,
        fixedMeals:
          isRefresh && isSingle && prev
            ? {
                breakfast: prev.breakfast,
                lunch: prev.lunch,
                dinner: prev.dinner
              }
            : undefined
      }

      let lastErr = null
      for (let i = 0; i < 3; i++) {
        this.setData({ retryCount: i })
        try {
          const res = await aiPlan(prompt, 'none', extra)
          this.setData({ result: res, err: '' })
          lastErr = null
          break
        } catch (e) {
          lastErr = e
        }
      }
      if (lastErr) throw lastErr
    } catch (e) {
      this.setData({ err: e.message || String(e) })
    } finally {
      this.setData({ loading: false })
    }
  }
})
