const app = getApp()
const cloud = require('../../utils/cloud')

const SIZE = 15
const GRID = []
for (let i = 0; i < SIZE; i++) {
  GRID.push((((i + 0.5) / SIZE) * 100).toFixed(3))
}

const STARS = []
const STAR_POINTS = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]]
for (let i = 0; i < STAR_POINTS.length; i++) {
  STARS.push({ k: i, left: GRID[STAR_POINTS[i][0]], top: GRID[STAR_POINTS[i][1]] })
}

const EMOTES = [
  { key: 'hurry', label: '催你' },
  { key: 'smug', label: '得意' },
  { key: 'plead', label: '求让' },
  { key: 'hug', label: '抱抱' },
  { key: 'think', label: '思考' },
  { key: 'win', label: '赢了' }
]

const EMOTE_TEXT = {}
for (let i = 0; i < EMOTES.length; i++) {
  EMOTE_TEXT[EMOTES[i].key] = EMOTES[i].label
}

Page({
  data: {
    statusBarH: 20,
    boardSize: 320,
    gridLines: GRID,
    stars: STARS,
    room: null,
    seat: -1,
    myColor: '',
    oppColor: '',
    stones: [],
    statusText: '',
    loading: true,
    errorText: '',
    pending: false,
    showResult: false,
    resultTitle: '',
    resultDesc: '',
    resultTone: '',
    rematchState: 'idle',
    rematchLabel: '再来一局',
    canUndo: false,
    undoPending: false,
    undoIncoming: false,
    undoBusy: false,
    emotes: EMOTES,
    panelOpen: false,
    sticker: null,
    hintMark: null
  },

  onLoad(options) {
    this.roomId = options.roomId || ''
    this.code = options.code || ''
    this.seat = -1
    this.loaded = false
    this.lastResultRound = null

    let width = 375
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      width = info.windowWidth || 375
    } catch (e) {
      width = 375
    }
    const boardSize = Math.min(Math.round(width - 32), 440)

    this.setData({
      statusBarH: app.globalData.statusBarHeight || 20,
      boardSize: boardSize
    })

    this.init()
  },

  onShow() {
    if (!this.loaded) return
    this.resume()
  },

  onHide() {
    this.stopWatch()
  },

  onUnload() {
    this.stopWatch()
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.stickerTimer) clearTimeout(this.stickerTimer)
    if (this.hintTimer) clearTimeout(this.hintTimer)
  },

  init() {
    const self = this
    app
      .ensureUid()
      .then(function (uid) {
        self.uid = uid
        if (self.roomId) {
          return cloud.call('get', { roomId: self.roomId })
        }
        if (self.code) {
          return cloud.call('join', { code: self.code })
        }
        throw new Error('缺少房间信息')
      })
      .then(function (res) {
        self.roomId = res.room._id
        self.seat = res.seat
        self.loaded = true
        self.applyRoom(res.room, res.seat)
        self.startWatch()
        wx.setKeepScreenOn({ keepScreenOn: true })
      })
      .catch(function (err) {
        self.setData({ loading: false, errorText: err.message })
      })
  },

  resume() {
    const self = this
    if (!this.roomId) return
    cloud
      .call('get', { roomId: this.roomId })
      .then(function (res) {
        self.applyRoom(res.room, self.seat)
        self.startWatch()
      })
      .catch(function () {})
  },

  applyRoom(room, seat) {
    if (!room) return
    if (seat === undefined || seat === null || seat < 0) {
      seat = room.playerIds ? room.playerIds.indexOf(this.uid) : -1
    }

    const mine = seat >= 0 && room.players[seat] ? room.players[seat].color : ''
    const opp = mine === 'black' ? 'white' : 'black'
    const winLine = room.winLine || []
    const stones = []

    for (let i = 0; i < room.board.length; i++) {
      const value = room.board[i]
      if (!value) continue
      const row = Math.floor(i / SIZE)
      const col = i % SIZE
      stones.push({
        i: i,
        left: GRID[col],
        top: GRID[row],
        color: value === 1 ? 'black' : 'white',
        win: winLine.indexOf(i) >= 0,
        last: !!(room.lastMove && room.lastMove.x === col && room.lastMove.y === row)
      })
    }

    let statusText = ''
    if (room.status === 'waiting') {
      statusText = '等 TA 进来'
    } else if (room.status === 'playing') {
      statusText = room.turn === mine ? '轮到你落子' : '等 TA 落子'
    } else if (room.status === 'closed') {
      statusText = '房间已关闭'
    } else {
      statusText = '这局结束了'
    }

    const rematchIds = room.rematchIds || []
    let rematchState = 'idle'
    let rematchLabel = '再来一局'
    if (room.status === 'finished') {
      if (rematchIds.indexOf(this.uid) >= 0) {
        rematchState = 'waiting'
        rematchLabel = '已邀请，等 TA'
      } else if (this.uid && (room.playerIds || []).length > 1) {
        const oppId = room.playerIds[0] === this.uid ? room.playerIds[1] : room.playerIds[0]
        if (rematchIds.indexOf(oppId) >= 0) {
          rematchState = 'invited'
          rematchLabel = 'TA 想再来一局'
        }
      }
    }

    const undoRequest = room.undoRequest || null
    const undoPending = !!(undoRequest && undoRequest.by === this.uid)
    const undoIncoming = !!(undoRequest && undoRequest.by !== this.uid)
    const canUndo =
      room.status === 'playing' &&
      !!room.lastMove &&
      room.lastMove.color === mine &&
      !undoRequest

    this.seat = seat
    this.setData({
      room: room,
      seat: seat,
      myColor: mine,
      oppColor: opp,
      stones: stones,
      statusText: statusText,
      loading: false,
      errorText: '',
      rematchState: rematchState,
      rematchLabel: rematchLabel,
      canUndo: canUndo,
      undoPending: undoPending,
      undoIncoming: undoIncoming
    })

    const emote = room.emote
    if (emote && emote.at && emote.at !== this.shownEmoteSeq && Date.now() - emote.at < 5000) {
      this.shownEmoteSeq = emote.at
      this.showSticker(emote.key, emote.color, emote.by === this.uid)
    }

    const hint = room.hint
    if (hint && hint.at && hint.at !== this.shownHintSeq && Date.now() - hint.at < 5000) {
      this.showHint(hint)
    }

    if (room.status !== 'playing' && this.data.panelOpen) {
      this.setData({ panelOpen: false })
    }

    if (room.status === 'finished') {
      if (this.lastResultRound !== room.round) {
        this.lastResultRound = room.round
        this.presentResult(room, mine)
      }
    } else if (room.status === 'closed') {
      this.setData({
        showResult: true,
        resultTitle: '房间已关闭',
        resultDesc: '回首页重新开一间吧',
        resultTone: 'closed',
        rematchState: 'closed'
      })
    } else {
      this.setData({ showResult: false })
    }
  },

  presentResult(room, mine) {
    let title = ''
    let desc = ''
    let tone = 'draw'

    if (room.winner === 'draw') {
      title = '和棋'
      desc = '棋盘满了，谁也没让谁'
      tone = 'draw'
    } else if (room.winner === mine) {
      title = '你赢了'
      desc = room.endReason === 'resign' ? 'TA 认输了' : '五子连珠，漂亮'
      tone = 'win'
    } else {
      title = '这局输了'
      desc = room.endReason === 'resign' ? '你认输了' : '差一点，再来一局'
      tone = 'lose'
    }

    this.setData({
      showResult: true,
      resultTitle: title,
      resultDesc: desc,
      resultTone: tone
    })
  },

  showSticker(key, color, mine) {
    const text = EMOTE_TEXT[key]
    if (!text) return

    const self = this
    this.setData({
      sticker: {
        text: text,
        side: color === 'black' ? 'left' : 'right',
        mine: !!mine
      }
    })

    if (this.stickerTimer) clearTimeout(this.stickerTimer)
    this.stickerTimer = setTimeout(function () {
      self.setData({ sticker: null })
    }, 2100)
  },

  showHint(hint) {
    const self = this
    this.shownHintSeq = hint.at
    this.setData({ hintMark: null })

    setTimeout(function () {
      self.setData({
        hintMark: {
          left: GRID[hint.x],
          top: GRID[hint.y],
          key: hint.at,
          mine: hint.by === self.uid
        }
      })
    }, 30)

    if (this.hintTimer) clearTimeout(this.hintTimer)
    this.hintTimer = setTimeout(function () {
      self.setData({ hintMark: null })
    }, 1600)
  },

  onTogglePanel() {
    this.setData({ panelOpen: !this.data.panelOpen })
  },

  onSendEmote(e) {
    const key = e.currentTarget.dataset.key
    const room = this.data.room
    if (!room || room.status !== 'playing') return

    const self = this
    this.setData({ panelOpen: false })

    cloud
      .call('sendEmote', { roomId: room._id, key: key })
      .then(function (res) {
        self.applyRoom(res.room, self.seat)
      })
      .catch(function (err) {
        self.toast(err.message)
      })
  },

  onBoardLongPress(e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return

    this.longPressed = true
    const room = this.data.room
    if (!room || room.status !== 'playing') return

    const self = this
    const query = wx.createSelectorQuery().in(this)
    query
      .select('#board')
      .boundingClientRect(function (rect) {
        if (!rect || !rect.width) return
        const col = Math.round(((touch.clientX - rect.left) / rect.width) * SIZE - 0.5)
        const row = Math.round(((touch.clientY - rect.top) / rect.height) * SIZE - 0.5)
        if (col < 0 || col > SIZE - 1 || row < 0 || row > SIZE - 1) return
        if (room.board[row * SIZE + col] !== 0) return

        if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
        cloud
          .call('sendHint', { roomId: room._id, x: col, y: row })
          .then(function (res) {
            self.applyRoom(res.room, self.seat)
          })
          .catch(function (err) {
            self.toast(err.message)
          })
      })
      .exec()
  },

  onBoardStart(e) {
    this.longPressed = false
    const touch = e.touches && e.touches[0]
    if (!touch) return
    this.touchStart = { x: touch.clientX, y: touch.clientY }
  },

  onBoardEnd(e) {
    if (this.longPressed) {
      this.longPressed = false
      this.touchStart = null
      return
    }

    const start = this.touchStart
    this.touchStart = null
    if (!start) return

    const touch = e.changedTouches && e.changedTouches[0]
    if (!touch) return
    if (Math.abs(touch.clientX - start.x) > 12 || Math.abs(touch.clientY - start.y) > 12) return

    const room = this.data.room
    if (!room) return
    if (room.status === 'waiting') {
      this.toast('等 TA 进来再落子')
      return
    }
    if (room.status !== 'playing') return
    if (this.data.pending) return
    if (this.data.myColor !== room.turn) {
      this.toast('等 TA 落子')
      return
    }

    const self = this
    const query = wx.createSelectorQuery().in(this)
    query
      .select('#board')
      .boundingClientRect(function (rect) {
        if (!rect || !rect.width) return
        const col = Math.round(((touch.clientX - rect.left) / rect.width) * SIZE - 0.5)
        const row = Math.round(((touch.clientY - rect.top) / rect.height) * SIZE - 0.5)
        if (col < 0 || col > SIZE - 1 || row < 0 || row > SIZE - 1) return
        self.place(row, col)
      })
      .exec()
  },

  place(row, col) {
    const room = this.data.room
    if (!room) return
    const idx = row * SIZE + col
    if (room.board[idx] !== 0) return

    const optimistic = this.data.stones.concat([
      {
        i: idx,
        left: GRID[col],
        top: GRID[row],
        color: this.data.myColor,
        win: false,
        last: true
      }
    ])

    this.setData({ pending: true, stones: optimistic })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })

    const self = this
    cloud
      .call('place', { roomId: room._id, x: col, y: row })
      .then(function (res) {
        self.setData({ pending: false })
        self.applyRoom(res.room, self.seat)
      })
      .catch(function (err) {
        self.setData({ pending: false })
        self.toast(err.message)
        self.resume()
      })
  },

  startWatch() {
    this.stopWatch()
    if (!this.data.room) return

    const self = this
    try {
      const db = wx.cloud.database()
      this.watcher = db
        .collection('rooms')
        .doc(this.data.room._id)
        .watch({
          onChange(snapshot) {
            const docs = snapshot.docs || []
            const doc = docs[0]
            if (!doc) return
            if (self.data.room && doc.version === self.data.room.version) return
            self.applyRoom(doc, self.seat)
          },
          onError(err) {
            console.warn('[watch] 实时监听失败，切换轮询', err)
            self.startPolling()
          }
        })
    } catch (e) {
      console.warn('[watch] 无法建立监听，切换轮询', e)
      this.startPolling()
    }
  },

  stopWatch() {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch (e) {}
      this.watcher = null
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  },

  startPolling() {
    if (this.pollTimer) return
    const self = this
    this.pollTimer = setInterval(function () {
      if (!self.roomId) return
      cloud
        .call('get', { roomId: self.roomId })
        .then(function (res) {
          self.applyRoom(res.room, self.seat)
        })
        .catch(function () {})
    }, 2500)
  },

  onRematch() {
    const room = this.data.room
    if (!room) return
    if (this.data.rematchState === 'waiting') return
    if (room.status === 'closed') return

    const self = this
    cloud
      .call('rematch', { roomId: room._id })
      .then(function (res) {
        if (res.room && res.room.status === 'playing') {
          self.lastResultRound = null
          self.setData({ showResult: false })
        }
        self.applyRoom(res.room, self.seat)
      })
      .catch(function (err) {
        self.toast(err.message)
      })
  },

  onCloseResult() {
    this.setData({ showResult: false })
  },

  onUndo() {
    const room = this.data.room
    if (!room || room.status !== 'playing') return
    if (this.data.undoBusy) return

    const self = this
    const isCancel = this.data.undoPending

    if (!isCancel && !this.data.canUndo) {
      this.toast('只能撤回自己刚下的一手')
      return
    }

    this.setData({ undoBusy: true })
    cloud
      .call(isCancel ? 'cancelUndo' : 'requestUndo', { roomId: room._id })
      .then(function (res) {
        self.setData({ undoBusy: false })
        self.applyRoom(res.room, self.seat)
        if (!isCancel) self.toast('等 TA 同意')
      })
      .catch(function (err) {
        self.setData({ undoBusy: false })
        self.toast(err.message)
      })
  },

  onUndoReply(e) {
    const room = this.data.room
    if (!room || this.data.undoBusy) return

    const accept = String(e.currentTarget.dataset.ok) === '1'
    const self = this
    this.setData({ undoBusy: true })

    cloud
      .call('respondUndo', { roomId: room._id, accept: accept })
      .then(function (res) {
        self.setData({ undoBusy: false, undoIncoming: false })
        self.applyRoom(res.room, self.seat)
        self.toast(accept ? '已悔棋' : '已拒绝')
      })
      .catch(function (err) {
        self.setData({ undoBusy: false })
        self.toast(err.message)
      })
  },

  onResign() {
    const room = this.data.room
    if (!room || room.status !== 'playing') return
    const self = this

    wx.showModal({
      title: '认输',
      content: '确定这局认输吗？',
      confirmText: '认输',
      confirmColor: '#B4584C',
      success(res) {
        if (!res.confirm) return
        cloud
          .call('resign', { roomId: room._id })
          .then(function (r) {
            self.applyRoom(r.room, self.seat)
          })
          .catch(function (err) {
            self.toast(err.message)
          })
      }
    })
  },

  onCopyCode() {
    const room = this.data.room
    if (!room) return
    wx.setClipboardData({
      data: room.code,
      success() {
        wx.showToast({ title: '房间号已复制', icon: 'none' })
      }
    })
  },

  onLeave() {
    const room = this.data.room
    if (!room) return
    const self = this

    cloud
      .call('leave', { roomId: room._id })
      .then(function () {
        self.loaded = false
        self.back()
      })
      .catch(function () {
        self.back()
      })
  },

  onBack() {
    const room = this.data.room
    const self = this

    if (!room) {
      this.back()
      return
    }

    if (room.status === 'waiting') {
      wx.showModal({
        title: '取消房间',
        content: '这间房还没开始，确定取消吗？',
        confirmText: '取消房间',
        confirmColor: '#B4584C',
        success(res) {
          if (res.confirm) self.onLeave()
        }
      })
      return
    }

    if (room.status === 'playing') {
      wx.showModal({
        title: '离开对局',
        content: '现在离开会算作认输，确定吗？',
        confirmText: '离开',
        confirmColor: '#B4584C',
        success(res) {
          if (!res.confirm) return
          cloud
            .call('resign', { roomId: room._id })
            .then(function () {
              self.loaded = false
              self.back()
            })
            .catch(function () {
              self.back()
            })
        }
      })
      return
    }

    this.back()
  },

  back() {
    wx.navigateBack({
      delta: 1,
      fail() {
        wx.reLaunch({ url: '/pages/index/index' })
      }
    })
  },

  onExit() {
    this.loaded = false
    this.back()
  },

  onShareAppMessage() {
    const room = this.data.room
    if (!room) {
      return { title: '双弈 · 只有你们两个人的五子棋', path: '/pages/index/index' }
    }
    return {
      title: '来跟我下一局五子棋（房间 ' + room.code + '）',
      path: '/pages/game/game?code=' + room.code
    }
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
