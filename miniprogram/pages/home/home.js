const { todayKey, intakeKey } = require('../../utils/storage.js')

Page({
  data: {
    intakeKey: ''
  },
  onShow() {
    const dk = todayKey()
    this.setData({ intakeKey: intakeKey(dk) })
  }
})
