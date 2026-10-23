const app = getApp()
const cloud = require('../../utils/cloud')

Page({
  data: {
    statusBarH: 20,
    code: '',
    canJoin: false,
    loading: false,
    booting: true,
    activeRoom: null,
    errorText: ''
  },

  onLoad() {
    this.setData({ statusBarH: app.globalData.statusBarHeight || 20 })
  },

  onShow() {
    this.loadMine()
  },

  loadMine() {
    const self = this
    app
      .ensureUid()
      .then(function () {
        return cloud.call('mine')
      })
      .then(function (res) {
        if (res.room) {
          const status = res.room.status
          const round = res.room.round || 1
          self.setData({
            booting: false,
            activeRoom: {
              id: res.room._id,
              code: res.room.code,
              status: status,
              round: round,
              caption: status === 'finished' ? '刚刚那局' : '未完的对局',
              stateText:
                status === 'waiting'
                  ? '等 TA 进来'
                  : status === 'playing'
                  ? '进行中 · 第 ' + round + ' 局'
                  : '30 分钟内可以回去再来一局',
              actionText: status === 'finished' ? '回去' : '继续'
            },
            errorText: ''
          })
        } else {
          self.setData({ booting: false, activeRoom: null })
        }
      })
      .catch(function (err) {
        self.setData({ booting: false, errorText: err.message })
      })
  },

  onCodeInput(e) {
    const value = (e.detail.value || '').replace(/[^0-9]/g, '').slice(0, 4)
    this.setData({ code: value, canJoin: value.length === 4 })
    return value
  },

  onCreate() {
    if (this.data.loading) return
    const self = this
    this.setData({ loading: true })

    app
      .ensureUid()
      .then(function () {
        return cloud.call('create')
      })
      .then(function (res) {
        self.setData({ loading: false })
        wx.navigateTo({ url: '/pages/game/game?roomId=' + res.room._id })
      })
      .catch(function (err) {
        self.setData({ loading: false })
        self.toast(err.message)
      })
  },

  onJoin() {
    const code = this.data.code
    if (code.length !== 4) {
      this.toast('请输入 4 位房间号')
      return
    }
    if (this.data.loading) return

    const self = this
    this.setData({ loading: true })

    app
      .ensureUid()
      .then(function () {
        return cloud.call('join', { code: code })
      })
      .then(function (res) {
        self.setData({ loading: false })
        wx.navigateTo({ url: '/pages/game/game?roomId=' + res.room._id })
      })
      .catch(function (err) {
        self.setData({ loading: false })
        self.toast(err.message)
      })
  },

  onResume() {
    const room = this.data.activeRoom
    if (!room) return
    wx.navigateTo({ url: '/pages/game/game?roomId=' + room.id })
  },

  toast(title) {
    const text = String(title || '')
    if (text.length > 36) console.warn('[toast] 完整信息：', text)
    wx.showToast({
      title: text.length > 36 ? text.slice(0, 36) + '…' : text,
      icon: 'none',
      duration: 2200
    })
  }
})
