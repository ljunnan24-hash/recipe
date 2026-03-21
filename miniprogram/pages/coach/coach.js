const { aiChat } = require('../../utils/api.js')
const { getJSON, KEYS } = require('../../utils/storage.js')

Page({
  data: {
    msg: '',
    loading: false,
    err: '',
    reply: ''
  },
  onInput(e) {
    this.setData({ msg: e.detail.value })
  },
  async onSend() {
    const message = (this.data.msg || '').trim()
    if (!message) {
      wx.showToast({ title: '请输入内容', icon: 'none' })
      return
    }
    const profile = getJSON(KEYS.profile, {})
    const systemInstruction =
      '你是营养与运动顾问，回答简洁实用。用户档案（JSON）：' +
      JSON.stringify(profile)
    this.setData({ loading: true, err: '', reply: '' })
    try {
      const { text } = await aiChat(message, systemInstruction)
      this.setData({ reply: text || '', msg: '' })
    } catch (e) {
      this.setData({ err: e.message || String(e) })
    } finally {
      this.setData({ loading: false })
    }
  }
})
