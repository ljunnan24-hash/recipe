/**
 * 小程序请求后端的根路径（须 HTTPS，且域名必须在微信公众平台「服务器域名 → request 合法域名」中配置）
 *
 * 须与 H5 实际调用的 API 根一致（同仓库 docs/DEPLOY.md）。
 * 示例：
 * - 同域反代： https://你的域名.com/api
 * - 子域 API： https://api.你的域名.com/api
 *
 * 开发工具里可勾选「不校验合法域名」先联调；真机/体验版必须公网 HTTPS + 已备案域名（按微信规则）。
 */
const API_BASE = 'https://ainutritist.site/api'

module.exports = {
  API_BASE
}
