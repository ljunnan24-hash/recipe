/**
 * 对齐 H5 index.tsx 中 LocalDB 使用的 localStorage 键名，便于双端数据一致或后续迁移
 */
const KEYS = {
  profile: 'wx_user_profile',
  onboarding: 'wx_onboarding_complete',
  selectedCanteen: 'wx_selected_canteen',
  healthReport: 'wx_health_report'
}

function todayKey() {
  const d = new Date()
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}

function intakeKey(dateKey) {
  return `wx_intake_${dateKey}`
}

function waterKey(dateKey) {
  return `wx_water_${dateKey}`
}

function getJSON(key, fallback) {
  try {
    const s = wx.getStorageSync(key)
    if (!s) return fallback
    return typeof s === 'string' ? JSON.parse(s) : s
  } catch (e) {
    return fallback
  }
}

function setJSON(key, value) {
  wx.setStorageSync(key, JSON.stringify(value))
}

module.exports = {
  KEYS,
  todayKey,
  intakeKey,
  waterKey,
  getJSON,
  setJSON
}
