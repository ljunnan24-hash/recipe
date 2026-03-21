const { KEYS, getJSON } = require('../../utils/storage.js')

Page({
  data: {
    preview: ''
  },
  onShow() {
    const p = getJSON(KEYS.profile, null)
    this.setData({
      preview: p ? JSON.stringify(p).slice(0, 200) + (JSON.stringify(p).length > 200 ? '…' : '') : '（尚未填写档案）'
    })
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
