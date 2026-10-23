const app = getApp()
const cloud = require('../../utils/cloud')
const audio = require('../../utils/audio')

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

const BOARD_CHARS = [
  '弱', '你', '吗', '猪', '呵', '饭', '小', '圾',
  '爆', '没', '狗', '？', '菜', '嘻', '个', '羊',
  '练', '垃', '嗯', '鸡', '多', '否', '哈', '了'
]

const SENTENCE_MAX = 50

// 危险分级：0 无 / 1 活三 / 2 冲四或双活三 / 3 活四或四三
// 判定方式：对每个空点做一次假设落子，统计「成五点」和「能形成活四的方向」
function countLine(board, x, y, dx, dy, color) {
  let count = 1

  let cx = x + dx
  let cy = y + dy
  while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === color) {
    count++
    cx += dx
    cy += dy
  }
  const afterEmpty = cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === 0

  cx = x - dx
  cy = y - dy
  while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === color) {
    count++
    cx -= dx
    cy -= dy
  }
  const beforeEmpty = cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === 0

  return { count: count, beforeEmpty: beforeEmpty, afterEmpty: afterEmpty }
}

function computeDangerLevels(board) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  const result = { black: 0, white: 0 }

  for (let color = 1; color <= 2; color++) {
    let winPoints = 0
    const openDirs = {}

    for (let i = 0; i < SIZE * SIZE; i++) {
      if (board[i] !== 0) continue
      const x = i % SIZE
      const y = (i - x) / SIZE

      board[i] = color
      let makesFive = false

      for (let d = 0; d < 4; d++) {
        if (countLine(board, x, y, dirs[d][0], dirs[d][1], color).count >= 5) {
          makesFive = true
          break
        }
      }

      if (makesFive) {
        winPoints++
      } else {
        for (let d = 0; d < 4; d++) {
          const info = countLine(board, x, y, dirs[d][0], dirs[d][1], color)
          if (info.count === 4 && info.beforeEmpty && info.afterEmpty) openDirs[d] = true
        }
      }

      board[i] = 0
    }

    const dirCount = Object.keys(openDirs).length
    let lv = 0
    if (winPoints >= 2) lv = 3
    else if (winPoints === 1 && dirCount >= 1) lv = 3
    else if (winPoints === 1) lv = 2
    else if (dirCount >= 2) lv = 2
    else if (dirCount === 1) lv = 1

    if (color === 1) result.black = lv
    else result.white = lv
  }

  return result
}

Page({
  data: {
    statusBarH: 20,
    boardSize: 320,
    gridLines: GRID,
    stars: STARS,
    room: null,
    roomCode: '',
    roomStatus: '',
    roomTurn: '',
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
    chars: BOARD_CHARS,
    charMax: SENTENCE_MAX,
    draft: '',
    draftScroll: 0,
    sending: false,
    panelOpen: false,
    msgBlack: null,
    msgWhite: null,
    preview: null,
    pendingStone: null,
    fireEnabled: true,
    fireBlackLv: 0,
    fireWhiteLv: 0,
    fireIncoming: false,
    firePending: false,
    fireValue: false,
    fireBusy: false,
    hintMark: null,
    soundOn: true
  },

  onLoad(options) {
    this.roomId = options.roomId || ''
    this.code = options.code || ''
    this.seat = -1
    this.loaded = false
    this.lastResultRound = null
    this.msgTimers = { black: null, white: null }
    this.shownMsgAt = { black: 0, white: 0 }

    let width = 375
    let height = 812
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      width = info.windowWidth || 375
      height = info.windowHeight || 812
    } catch (e) {
      width = 375
      height = 812
    }

    // 导航 44 + 玩家条 30 + 消息区 78 + 字盘预留 190 + 操作栏 50 + 底部 17 + 余量 8
    const CHROME = 417
    const statusBarH = app.globalData.statusBarHeight || 20
    const fitHeight = height - statusBarH - CHROME
    const boardSize = Math.max(200, Math.min(Math.round(width - 32), fitHeight, 440))

    this.setData({
      statusBarH: app.globalData.statusBarHeight || 20,
      boardSize: boardSize,
      soundOn: audio.anyOn()
    })

    this.init()
  },

  onShow() {
    this.setData({ soundOn: audio.anyOn() })
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
    if (this.hintTimer) clearTimeout(this.hintTimer)
    if (this.msgTimers) {
      clearTimeout(this.msgTimers.black)
      clearTimeout(this.msgTimers.white)
    }
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
        self.shownMsgAt.black = res.room.sentenceBlack ? res.room.sentenceBlack.at : 0
        self.shownMsgAt.white = res.room.sentenceWhite ? res.room.sentenceWhite.at : 0
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
        self.shownMsgAt.black = res.room.sentenceBlack ? res.room.sentenceBlack.at : 0
        self.shownMsgAt.white = res.room.sentenceWhite ? res.room.sentenceWhite.at : 0
        self.applyRoom(res.room, self.seat)
        self.startWatch()
      })
      .catch(function () {})
  },

  applyRoom(room, seat, opts) {
    if (!room) return
    if (seat === undefined || seat === null || seat < 0) {
      seat = room.playerIds ? room.playerIds.indexOf(this.uid) : -1
    }

    const mine = seat >= 0 && room.players[seat] ? room.players[seat].color : ''
    const opp = mine === 'black' ? 'white' : 'black'
    const winLine = room.winLine || []

    // 乐观子对账：服务器棋盘上该点已是我的颜色 → 确认，摘掉标记；
    // 服务器已走过这手但落点不是我的子（被拒/房间状态变了）→ 撤掉；
    // 服务器还没追平（watch 旧快照）→ 继续用乐观棋盘展示
    let board = room.board
    let pendingStone = this.data.pendingStone
    if (pendingStone) {
      const pIdx = pendingStone.row * SIZE + pendingStone.col
      const expect = pendingStone.color === 'black' ? 1 : 2
      if (room.board[pIdx] === expect) {
        pendingStone = null
      } else if (room.status !== 'playing' || room.moveCount >= pendingStone.expectedMoveCount) {
        pendingStone = null
      } else {
        board = room.board.slice()
        board[pIdx] = expect
      }
    }

    const stones = []
    for (let i = 0; i < board.length; i++) {
      const value = board[i]
      if (!value) continue
      const row = Math.floor(i / SIZE)
      const col = i % SIZE
      const isPending = !!(pendingStone && pendingStone.row === row && pendingStone.col === col)
      stones.push({
        i: i,
        left: GRID[col],
        top: GRID[row],
        color: value === 1 ? 'black' : 'white',
        win: winLine.indexOf(i) >= 0,
        pending: isPending,
        last:
          isPending ||
          !!(room.lastMove && room.lastMove.x === col && room.lastMove.y === row)
      })
    }

    let statusText = ''
    if (room.status === 'waiting') {
      statusText = '等 TA 进来'
    } else if (room.status === 'playing') {
      statusText = room.turn === mine && !pendingStone ? '轮到你落子' : '等 TA 落子'
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

    const currentPreview = this.data.preview
    let nextPreview = currentPreview
    if (currentPreview) {
      const occupied = room.board[currentPreview.row * SIZE + currentPreview.col] !== 0
      const invalid = occupied || room.status !== 'playing' || room.turn !== mine
      if (invalid || (opts && opts.clearPreview)) nextPreview = null
    }

    // 对方落子：只在 moveCount 前进且最后一手不是我方时响一声（进房时补看的不响）
    const moveCount = room.moveCount || 0
    const lastMove = room.lastMove || null
    if (
      room.status === 'playing' &&
      lastMove &&
      lastMove.color !== mine &&
      this.lastSeenMove !== undefined &&
      moveCount > this.lastSeenMove
    ) {
      audio.play('place_op', 0.55)
    }
    this.lastSeenMove = moveCount

    // 完整房间只留在逻辑层，不再随 setData 传给视图层（board/history 很大，容易造成掉帧）
    this.data.room = room

    const fireEnabled = room.fireEnabled !== false
    const levels =
      room.status === 'playing' ? computeDangerLevels(board) : { black: 0, white: 0 }
    const fireReq = room.fireRequest || null
    const fireIncoming = !!(fireReq && fireReq.by !== this.uid)
    const firePending = !!(fireReq && fireReq.by === this.uid)

    const payload = {
      roomCode: room.code || '',
      roomStatus: room.status || '',
      roomTurn: room.turn || '',
      fireEnabled: fireEnabled,
      fireBlackLv: fireEnabled ? levels.black : 0,
      fireWhiteLv: fireEnabled ? levels.white : 0,
      fireIncoming: fireIncoming,
      firePending: firePending,
      fireValue: !!(fireReq && fireReq.value),
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
      undoIncoming: undoIncoming,
      preview: nextPreview,
      pendingStone: pendingStone
    }
    if (opts && opts.settlePending) payload.pending = false

    this.setData(payload)

    const hint = room.hint
    if (hint && hint.at && hint.at !== this.shownHintSeq && Date.now() - hint.at < 5000) {
      this.showHint(hint)
    }

    this.syncMessages(room)

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

    if (tone === 'win') audio.play('win', 0.75)
    else if (tone === 'lose') audio.play('lose', 0.7)
    else if (tone === 'draw') audio.play('draw', 0.7)
  },

  syncMessages(room) {
    const self = this
    const slots = [
      { color: 'black', slot: room.sentenceBlack, key: 'msgBlack' },
      { color: 'white', slot: room.sentenceWhite, key: 'msgWhite' }
    ]

    slots.forEach(function (item) {
      const slot = item.slot
      const at = slot && slot.at ? slot.at : 0

      if (!at) {
        if (self.shownMsgAt[item.color]) self.shownMsgAt[item.color] = 0
        if (self.data[item.key]) {
          const clear = {}
          clear[item.key] = null
          self.setData(clear)
        }
        return
      }

      if (self.shownMsgAt[item.color] === at) return
      self.shownMsgAt[item.color] = at

      const payload = {}
      payload[item.key] = { text: slot.text, by: slot.by, mine: slot.by === self.uid }
      self.setData(payload)

      if (slot.by !== self.uid) audio.play('msg', 0.5)

      if (self.msgTimers[item.color]) clearTimeout(self.msgTimers[item.color])
      self.msgTimers[item.color] = setTimeout(function () {
        const clear = {}
        clear[item.key] = null
        self.setData(clear)
      }, 3000)
    })
  },

  // 用户手势：解锁音频（iOS 必须）+ 轻点击音
  tap() {
    audio.unlock()
    audio.startBgm()
    audio.play('tap', 0.45)
  },

  onToggleSound() {
    audio.unlock()
    audio.toggleAll()
    const on = audio.anyOn()
    this.setData({ soundOn: on })
    if (on) audio.startBgm()
  },

  onTogglePanel() {
    this.tap()
    this.setData({ panelOpen: !this.data.panelOpen })
  },

  onCharTap(e) {
    const ch = e.currentTarget.dataset.ch
    const draft = this.data.draft

    if (draft.length >= SENTENCE_MAX) {
      this.toast('最多 ' + SENTENCE_MAX + ' 个字')
      return
    }

    audio.play('tap', 0.5)

    this.setData({
      draft: draft + ch,
      draftScroll: this.data.draftScroll + 2000
    })
  },

  onBackspace() {
    const draft = this.data.draft
    if (!draft) return
    this.setData({ draft: draft.slice(0, -1) })
  },

  onClearDraft() {
    if (!this.data.draft) return
    this.setData({ draft: '' })
  },

  onSendSentence() {
    this.tap()
    const room = this.data.room
    const draft = this.data.draft

    if (!room || room.status !== 'playing') return
    if (!draft) {
      this.toast('先点几个字')
      return
    }
    if (this.data.sending) return

    const self = this
    this.setData({ sending: true })

    cloud
      .call('sendSentence', { roomId: room._id, text: draft })
      .then(function (res) {
        self.setData({ sending: false })
        self.applyRoom(res.room, self.seat)
      })
      .catch(function (err) {
        self.setData({ sending: false })
        self.toast(err.message)
      })
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

  onBoardLongPress(e) {
    const touch = e.touches && e.touches[0]
    if (!touch) return

    this.longPressed = true
    if (this.data.preview) this.setData({ preview: null })
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
    audio.unlock()
    audio.startBgm()
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
        self.setPreview(row, col)
      })
      .exec()
  },

  setPreview(row, col) {
    const room = this.data.room
    if (!room) return

    const idx = row * SIZE + col
    if (room.board[idx] !== 0) return

    audio.play('tap', 0.45)

    this.setData({
      preview: {
        row: row,
        col: col,
        left: GRID[col],
        top: GRID[row],
        color: this.data.myColor
      }
    })
  },

  onCancelPreview() {
    if (this.data.pending) return
    this.setData({ preview: null })
  },

  onConfirmPlace() {
    const preview = this.data.preview
    if (!preview || this.data.pending) return
    this.place(preview.row, preview.col)
  },

  place(row, col) {
    const room = this.data.room
    if (!room) return

    const idx = row * SIZE + col
    if (room.board[idx] !== 0) {
      this.setData({ preview: null })
      return
    }
    if (this.data.pending) return

    // 乐观渲染：先摆上一颗"待确认"的实心子，不等服务器
    // 落子声同步在点击时就响，不等服务端回包
    const color = this.data.myColor
    audio.play('place', 0.7)
    this.setData({
      pending: true,
      preview: null,
      pendingStone: {
        row: row,
        col: col,
        left: GRID[col],
        top: GRID[row],
        color: color,
        expectedMoveCount: room.moveCount + 1
      }
    })
    // 立即用当前房间数据本地重渲染一次，乐观子马上上板（对账分支会把它合进 stones）
    this.applyRoom(room, this.seat)

    const self = this
    cloud
      .call('place', { roomId: room._id, x: col, y: row })
      .then(function (res) {
        self.applyRoom(res.room, self.seat, { settlePending: true })
      })
      .catch(function (err) {
        const msg = err.message || ''
        const keepPreview = msg.indexOf('网络') >= 0
        const ps = self.data.pendingStone
        const payload = { pending: false, pendingStone: null }
        // 网络错误：退回预览态，可直接重新确认；明确拒绝：撤子并拉最新状态
        payload.preview =
          keepPreview && ps
            ? { row: ps.row, col: ps.col, left: ps.left, top: ps.top, color: ps.color }
            : null
        self.setData(payload)
        // 本地重渲染一次，立刻把乐观子从棋盘上撤掉（拒绝场景随后还会被 resume 的真值覆盖）
        self.applyRoom(self.data.room, self.seat)
        self.toast(msg)
        if (!keepPreview) self.resume()
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
    this.tap()
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
    this.tap()
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

  onToggleFire() {
    this.tap()
    const room = this.data.room
    if (!room || room.status !== 'playing' || this.data.fireBusy) return

    if (this.data.firePending) {
      this.toast('已经发过请求了，等 TA 同意')
      return
    }

    const target = !this.data.fireEnabled
    const self = this

    wx.showModal({
      title: target ? '开启火势' : '关闭火势',
      content: '棋盘边缘的火势动画会' + (target ? '打开' : '关掉') + '，需要 TA 同意。',
      confirmText: '发请求',
      confirmColor: '#B4584C',
      success(res) {
        if (!res.confirm) return
        self.setData({ fireBusy: true })
        cloud
          .call('requestFire', { roomId: room._id, enabled: target })
          .then(function (r) {
            self.setData({ fireBusy: false })
            self.applyRoom(r.room, self.seat)
            self.toast('等 TA 同意')
          })
          .catch(function (err) {
            self.setData({ fireBusy: false })
            self.toast(err.message)
          })
      }
    })
  },

  onRespondFire(e) {
    const accept = String(e.currentTarget.dataset.ok) === '1'
    const room = this.data.room
    if (!room || this.data.fireBusy) return

    const self = this
    this.setData({ fireBusy: true })

    cloud
      .call('respondFire', { roomId: room._id, accept: accept })
      .then(function (r) {
        self.setData({ fireBusy: false })
        self.applyRoom(r.room, self.seat)
        self.toast(accept ? '已更新' : '已拒绝')
      })
      .catch(function (err) {
        self.setData({ fireBusy: false })
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
    this.tap()
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
