/**
 * 与仓库根目录 api.ts 对应的后端接口（路径一致，便于对照迁移 UI）
 */
const { post, get } = require('./request.js')

function aiScan(imageBase64, mimeType) {
  return post('/ai/scan', { imageBase64, mimeType })
}

function aiPlan(prompt, selectedCanteen, extra) {
  return post('/ai/plan', {
    prompt,
    selectedCanteen: selectedCanteen || 'none',
    profile: extra && extra.profile,
    targets: extra && extra.targets,
    avoidNames: extra && extra.avoidNames
  })
}

function getCanteenDishes(canteen) {
  const c = encodeURIComponent(canteen || 'szu_south')
  return get(`/canteen/dishes?canteen=${c}`)
}

function aiChat(message, systemInstruction) {
  return post('/ai/chat', { message, systemInstruction })
}

function aiHealthReport(profile, targets) {
  return post('/ai/report', { profile, targets })
}

module.exports = {
  aiScan,
  aiPlan,
  getCanteenDishes,
  aiChat,
  aiHealthReport
}
