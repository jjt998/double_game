const cloud = require('./utils/cloud')
const audio = require('./utils/audio')

App({
  globalData: {
    uid: '',
    statusBarHeight: 20
  },

  onLaunch() {
    audio.init()
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      this.globalData.statusBarHeight = info.statusBarHeight || 20
    } catch (e) {
      this.globalData.statusBarHeight = 20
    }

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    // 留空则使用当前的默认云开发环境；也可以直接填入环境 ID
    const CLOUD_ENV = 'cloud1-d8gye31fxb604235b'
    if (CLOUD_ENV) {
      wx.cloud.init({ env: CLOUD_ENV, traceUser: true })
    } else {
      wx.cloud.init({ traceUser: true })
    }

    this.ensureUid().catch(function (err) {
      console.error('身份初始化失败', err)
    })

    // 自动确保 rooms 集合存在，省掉去控制台手动建表这一步
    cloud.call('init').catch(function (err) {
      console.warn('自动初始化数据表失败，可稍后重试', err)
    })
  },

  onShow() {
    audio.resumeAll()
  },

  onHide() {
    audio.pauseAll()
  },

  ensureUid() {
    if (this.globalData.uid) return Promise.resolve(this.globalData.uid)
    if (this._uidPromise) return this._uidPromise

    const self = this
    this._uidPromise = cloud
      .call('whoami')
      .then(function (res) {
        self.globalData.uid = res.uid
        return res.uid
      })
      .catch(function (err) {
        self._uidPromise = null
        throw err
      })

    return this._uidPromise
  }
})
