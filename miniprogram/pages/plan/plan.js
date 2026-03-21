const { aiPlan } = require('../../utils/api.js')
const { getJSON, KEYS } = require('../../utils/storage.js')

Page({
  data: {
    loading: false,
    err: '',
    result: null
  },
  async onTryPlan() {
    this.setData({ loading: true, err: '', result: null })
    try {
      const profile = getJSON(KEYS.profile, null)
      const prompt =
        '请根据用户档案生成一日三餐简要方案，控制总热量。用户档案 JSON：' +
        JSON.stringify(profile || {})
      const res = await aiPlan(prompt, 'none', { profile })
      this.setData({ result: res })
    } catch (e) {
      this.setData({ err: e.message || String(e) })
    } finally {
      this.setData({ loading: false })
    }
  }
})
