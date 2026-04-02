const { aiPlan } = require('../../utils/api.js')
const { getJSON, KEYS } = require('../../utils/storage.js')

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
  async onTryPlan() {
    this.setData({ loading: true, err: '', result: null, retryCount: 0 })
    try {
      const profile = getJSON(KEYS.profile, null)
      const prompt = buildPlanPrompt(profile)

      // 后端本身会重试一次；前端再补 1-2 次，减少偶发“方案不符合要求”
      let lastErr = null
      for (let i = 0; i < 3; i++) {
        this.setData({ retryCount: i })
        try {
          const res = await aiPlan(prompt, 'none', { profile })
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
