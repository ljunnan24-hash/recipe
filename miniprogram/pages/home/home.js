const { todayKey, intakeKey, waterKey, getJSON } = require('../../utils/storage.js')

function sumNutrition(items) {
  const arr = Array.isArray(items) ? items : []
  return arr.reduce(
    (acc, it) => {
      acc.calories += Number(it?.calories) || 0
      acc.protein += Number(it?.protein) || 0
      acc.carbs += Number(it?.carbs) || 0
      acc.fat += Number(it?.fat) || 0
      return acc
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  )
}

Page({
  data: {
    intakeKey: '',
    dateKey: '',
    totals: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    waterMl: 0,
    items: []
  },
  onShow() {
    const dk = todayKey()
    const key = intakeKey(dk)
    const items = getJSON(key, [])
    const totals = sumNutrition(items)
    const water = Number(wx.getStorageSync(waterKey(dk))) || 0
    this.setData({
      dateKey: dk,
      intakeKey: key,
      items,
      totals: {
        calories: Math.round(totals.calories),
        protein: Number(totals.protein.toFixed(1)),
        carbs: Number(totals.carbs.toFixed(1)),
        fat: Number(totals.fat.toFixed(1))
      },
      waterMl: water
    })
  }
})
