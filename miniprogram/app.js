// app.js — 全局生命周期（可在此做版本检查、静默登录等）
App({
  onLaunch() {
    console.log('[recipe] app launch')
  },
  globalData: {
    /** 与 H5 版 LocalDB 键名保持一致，便于以后数据互通或迁移 */
    storagePrefix: 'wx_'
  }
})
