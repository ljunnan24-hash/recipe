Component({
  properties: {
    title: { type: String, value: 'Recipe' },
    floating: { type: Boolean, value: false }
  },
  data: {
    statusBarHeight: 0
  },
  lifetimes: {
    attached() {
      try {
        const info = wx.getSystemInfoSync()
        this.setData({ statusBarHeight: info.statusBarHeight || 0 })
      } catch {
        this.setData({ statusBarHeight: 0 })
      }
    }
  }
})

