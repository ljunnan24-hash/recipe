const { API_BASE } = require('./config.js')

/**
 * 封装 wx.request，与 H5 版 fetch + JSON 行为对齐
 * @param {string} path 如 '/ai/scan'（不含 /api 前缀，因 API_BASE 已含 /api）
 * @param {{ method?: string, json?: object }} options
 */
function request(path, options = {}) {
  const { method = 'GET', json, timeoutMs } = options
  const url = `${API_BASE.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`

  const header = {}
  if (method !== 'GET' && method !== 'HEAD' && json !== undefined) {
    header['Content-Type'] = 'application/json'
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      header,
      /** AI 识图/配餐/对话可能较慢，默认 60s，避免 errMsg 含 timeout */
      timeout: timeoutMs != null ? timeoutMs : 120000,
      data: json !== undefined ? json : undefined,
      success(res) {
        const { statusCode, data } = res
        if (statusCode >= 200 && statusCode < 300) {
          resolve(data)
          return
        }
        const msg =
          (data && (data.error || data.message)) || `请求失败 ${statusCode}`
        reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)))
      },
      fail(err) {
        reject(err && err.errMsg ? new Error(err.errMsg) : new Error('网络错误'))
      }
    })
  })
}

function post(path, json) {
  return request(path, { method: 'POST', json })
}

function get(path) {
  return request(path, { method: 'GET' })
}

module.exports = {
  request,
  post,
  get
}
