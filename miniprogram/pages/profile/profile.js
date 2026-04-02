const { KEYS, getJSON, setJSON } = require('../../utils/storage.js')

function safeNum(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

Page({
  data: {
    preview: '',
    weight: '',
    height: '',
    goal: 'maintain'
  },
  onShow() {
    const p = getJSON(KEYS.profile, null)
    const weight = p && p.weight != null ? String(p.weight) : ''
    const height = p && p.height != null ? String(p.height) : ''
    const goal = (p && p.goal) || 'maintain'
    this.setData({
      weight,
      height,
      goal,
      preview: p
        ? JSON.stringify(p).slice(0, 200) + (JSON.stringify(p).length > 200 ? '…' : '')
        : '（尚未填写档案）'
    })
  },
  onWeight(e) {
    this.setData({ weight: e.detail.value })
  },
  onHeight(e) {
    this.setData({ height: e.detail.value })
  },
  onGoalTap(e) {
    const goal = e.currentTarget.dataset.goal
    this.setData({ goal })
  },
  onSave() {
    const old = getJSON(KEYS.profile, {}) || {}
    const next = {
      ...old,
      weight: safeNum(this.data.weight, old.weight || 60),
      height: safeNum(this.data.height, old.height || 170),
      goal: this.data.goal || old.goal || 'maintain'
    }
    setJSON(KEYS.profile, next)
    wx.showToast({ title: '已保存', icon: 'success' })
    this.onShow()
  },
  onClear() {
    wx.showModal({
      title: '确认清空',
      content: '将清除本小程序本地存储，与 H5 无关。',
      success: (res) => {
        if (!res.confirm) return
        wx.clearStorageSync()
        this.onShow()
        wx.showToast({ title: '已清空', icon: 'success' })
      }
    })
  }
})
