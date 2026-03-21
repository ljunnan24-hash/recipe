const { aiScan } = require('../../utils/api.js')

Page({
  data: {
    loading: false,
    err: '',
    scan: null
  },
  onPick() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const f = res.tempFiles[0]
        if (!f) return
        this.readAndScan(f.tempFilePath, f.fileType || 'image')
      },
      fail: (e) => {
        if (e.errMsg && e.errMsg.indexOf('cancel') >= 0) return
        this.setData({ err: e.errMsg || '选图失败' })
      }
    })
  },
  readAndScan(tempFilePath, fileType) {
    this.setData({ loading: true, err: '', scan: null })
    const fs = wx.getFileSystemManager()
    fs.readFile({
      filePath: tempFilePath,
      encoding: 'base64',
      success: async (r) => {
        const mimeType =
          fileType === 'image' || !fileType
            ? 'image/jpeg'
            : `image/${fileType}`
        try {
          const data = await aiScan(r.data, mimeType)
          this.setData({ scan: data })
        } catch (e) {
          this.setData({ err: e.message || String(e) })
        } finally {
          this.setData({ loading: false })
        }
      },
      fail: (e) => {
        this.setData({
          loading: false,
          err: e.errMsg || '读取图片失败'
        })
      }
    })
  }
})
