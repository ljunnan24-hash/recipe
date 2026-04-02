const TABS = [
  { pagePath: 'pages/home/home' },
  { pagePath: 'pages/plan/plan' },
  { pagePath: 'pages/scan/scan' },
  { pagePath: 'pages/coach/coach' },
  { pagePath: 'pages/profile/profile' }
]

Component({
  data: {
    selected: 0
  },
  lifetimes: {
    attached() {
      this.updateSelected()
    },
    ready() {
      this.updateSelected()
    }
  },
  pageLifetimes: {
    show() {
      this.updateSelected()
    }
  },
  methods: {
    updateSelected() {
      const pages = getCurrentPages()
      const cur = pages && pages.length ? pages[pages.length - 1] : null
      const route = cur ? cur.route : ''
      const idx = TABS.findIndex((t) => t.pagePath === route)
      this.setData({ selected: idx >= 0 ? idx : 0 })
    },
    onSwitch(e) {
      const idx = Number(e.currentTarget.dataset.idx)
      const tab = TABS[idx]
      if (!tab) return
      wx.switchTab({ url: `/${tab.pagePath}` })
    }
  }
})

