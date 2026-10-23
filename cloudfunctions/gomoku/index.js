const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const rooms = db.collection('rooms')

const SIZE = 15
const CELLS = SIZE * SIZE
const SALT = 'shuangyi-room-v1'
const ROOM_TTL = 12 * 60 * 60 * 1000
const FINISHED_TTL = 30 * 60 * 1000
const ACTIVE = ['waiting', 'playing']

function uidOf(openid) {
  return crypto
    .createHash('sha256')
    .update(SALT + openid)
    .digest('hex')
    .slice(0, 16)
}

function fail(message) {
  const err = new Error(message)
  err.expected = true
  return err
}

function emptyBoard() {
  const arr = []
  for (let i = 0; i < CELLS; i++) arr.push(0)
  return arr
}

function checkWin(board, x, y, value) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (let d = 0; d < dirs.length; d++) {
    const dx = dirs[d][0]
    const dy = dirs[d][1]
    const line = [y * SIZE + x]
    for (let s = -1; s <= 1; s += 2) {
      let cx = x + dx * s
      let cy = y + dy * s
      while (cx >= 0 && cx < SIZE && cy >= 0 && cy < SIZE && board[cy * SIZE + cx] === value) {
        line.push(cy * SIZE + cx)
        cx += dx * s
        cy += dy * s
      }
    }
    if (line.length >= 5) return line.sort(function (a, b) { return a - b })
  }
  return null
}

async function createRoom(uid) {
  const now = Date.now()

  const mine = await rooms
    .where({ playerIds: uid, status: _.in(ACTIVE) })
    .orderBy('updatedAt', 'desc')
    .limit(5)
    .get()

  for (let i = 0; i < mine.data.length; i++) {
    const room = mine.data[i]
    if (now - (room.updatedAt || 0) < ROOM_TTL) {
      return { ok: true, room: room, seat: room.playerIds.indexOf(uid) }
    }
    await rooms.doc(room._id).update({
      data: { status: 'closed', updatedAt: now, version: _.inc(1) }
    })
  }

  let code = ''
  for (let i = 0; i < 20; i++) {
    const candidate = String(Math.floor(1000 + Math.random() * 9000))
    const dup = await rooms.where({ code: candidate, status: _.in(ACTIVE) }).count()
    if (!dup.total) {
      code = candidate
      break
    }
  }
  if (!code) throw fail('房间号暂时用完了，稍等一下再试')

  const doc = {
    code: code,
    status: 'waiting',
    board: emptyBoard(),
    history: [],
    undoRequest: null,
    emote: null,
    hint: null,
    turn: 'black',
    winner: '',
    winLine: [],
    endReason: '',
    lastMove: null,
    moveCount: 0,
    version: 0,
    round: 1,
    players: [{ color: 'black' }],
    playerIds: [uid],
    playerCount: 1,
    rematchIds: [],
    createdAt: now,
    updatedAt: now
  }

  const added = await rooms.add({ data: doc })
  doc._id = added._id
  return { ok: true, room: doc, seat: 0 }
}

async function joinRoom(uid, code) {
  if (!/^\d{4}$/.test(String(code || ''))) throw fail('房间号是 4 位数字')

  const found = await rooms
    .where({ code: String(code), status: _.in(ACTIVE) })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get()

  let room = found.data[0] || null

  if (!room) {
    const recent = await rooms
      .where({ code: String(code), status: 'finished' })
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get()
    const candidate = recent.data[0]
    if (candidate && Date.now() - (candidate.updatedAt || 0) <= FINISHED_TTL) {
      if (candidate.playerIds.indexOf(uid) < 0) throw fail('这局已经结束了')
      return { ok: true, room: candidate, seat: candidate.playerIds.indexOf(uid) }
    }
    throw fail('房间不存在，或者已经结束了')
  }

  if (room.playerIds.indexOf(uid) >= 0) {
    return { ok: true, room: room, seat: room.playerIds.indexOf(uid) }
  }
  if (room.status === 'playing' || room.playerCount >= 2) {
    throw fail('这局已经开始了')
  }

  const now = Date.now()
  const updated = await rooms
    .where({ _id: room._id, status: 'waiting', playerCount: 1 })
    .update({
      data: {
        players: _.push([{ color: 'white' }]),
        playerIds: _.push([uid]),
        playerCount: 2,
        status: 'playing',
        turn: 'black',
        updatedAt: now,
        version: _.inc(1)
      }
    })

  if (!updated.stats.updated) {
    const again = await rooms.doc(room._id).get()
    if (again.data && again.data.playerIds.indexOf(uid) >= 0) {
      return { ok: true, room: again.data, seat: again.data.playerIds.indexOf(uid) }
    }
    throw fail('手慢了一步，这间房已经满了')
  }

  const fresh = await rooms.doc(room._id).get()
  return { ok: true, room: fresh.data, seat: fresh.data.playerIds.indexOf(uid) }
}

async function getRoom(uid, roomId, code) {
  let room = null
  if (roomId) {
    const res = await rooms.doc(roomId).get().catch(function () { return null })
    room = res && res.data ? res.data : null
  } else if (code) {
    const res = await rooms
      .where({ code: String(code), status: _.in(ACTIVE) })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get()
    room = res.data[0] || null
  }
  if (!room) throw fail('房间不存在，或者已经关闭了')
  return { ok: true, room: room, seat: room.playerIds.indexOf(uid) }
}

async function placeStone(uid, roomId, x, y) {
  x = Number(x)
  y = Number(y)
  if (!(x >= 0 && x < SIZE && y >= 0 && y < SIZE)) throw fail('落子位置不对')

  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status === 'waiting') throw fail('对方还没进来')
  if (room.status !== 'playing') throw fail('这局已经结束了')

  const seat = room.playerIds.indexOf(uid)
  if (seat < 0) throw fail('你不在这个房间里')
  const color = room.players[seat].color
  if (room.turn !== color) throw fail('还没轮到你')

  const idx = y * SIZE + x
  if (room.board[idx] !== 0) throw fail('这里已经有棋子了')

  const board = room.board.slice()
  board[idx] = color === 'black' ? 1 : 2
  const winLine = checkWin(board, x, y, board[idx])
  const moveCount = room.moveCount + 1

  const data = {
    board: board,
    history: (room.history || []).concat([{ x: x, y: y, color: color }]),
    undoRequest: null,
    moveCount: moveCount,
    turn: color === 'black' ? 'white' : 'black',
    lastMove: _.set({ x: x, y: y, color: color }),
    updatedAt: Date.now(),
    version: _.inc(1)
  }

  if (winLine) {
    data.status = 'finished'
    data.winner = color
    data.winLine = winLine
    data.endReason = 'five'
    data.turn = ''
  } else if (moveCount >= CELLS) {
    data.status = 'finished'
    data.winner = 'draw'
    data.winLine = []
    data.endReason = 'draw'
    data.turn = ''
  }

  const updated = await rooms
    .where({ _id: roomId, status: 'playing', turn: color, moveCount: room.moveCount })
    .update({ data: data })

  if (!updated.stats.updated) throw fail('棋盘刚刚变了，再看一眼')

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function rematch(uid, roomId) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'finished') throw fail('这局还没结束')
  if (room.playerIds.indexOf(uid) < 0) throw fail('你不在这个房间里')
  if (room.playerCount < 2) throw fail('对方不在房间里')

  const rematchIds = room.rematchIds || []
  if (rematchIds.indexOf(uid) >= 0) {
    return { ok: true, room: room, waiting: true }
  }

  const nextIds = rematchIds.concat([uid])
  const now = Date.now()

  if (nextIds.length >= 2) {
    const swapped = room.players.map(function (p) {
      return { color: p.color === 'black' ? 'white' : 'black' }
    })
    const data = {
      board: emptyBoard(),
      history: [],
      undoRequest: null,
      status: 'playing',
      turn: 'black',
      winner: '',
      winLine: [],
      endReason: '',
      lastMove: null,
      moveCount: 0,
      rematchIds: [],
      round: (room.round || 1) + 1,
      players: swapped,
      updatedAt: now,
      version: _.inc(1)
    }
    const updated = await rooms
      .where({ _id: roomId, status: 'finished', version: room.version })
      .update({ data: data })
    if (!updated.stats.updated) throw fail('状态刚变过，再试一次')
  } else {
    await rooms.doc(roomId).update({
      data: { rematchIds: nextIds, updatedAt: now, version: _.inc(1) }
    })
  }

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function requestUndo(uid, roomId) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'playing') throw fail('这局已经结束了')

  const seat = room.playerIds.indexOf(uid)
  if (seat < 0) throw fail('你不在这个房间里')
  const color = room.players[seat].color

  if (room.undoRequest) throw fail('已经有一个悔棋请求了')
  if (!room.lastMove || room.lastMove.color !== color) throw fail('只能撤回自己刚下的一手')
  if (room.turn === color) throw fail('现在还不能悔棋')

  const updated = await rooms
    .where({ _id: roomId, status: 'playing', moveCount: room.moveCount })
    .update({
      data: {
        undoRequest: _.set({ by: uid, color: color, at: Date.now() }),
        updatedAt: Date.now(),
        version: _.inc(1)
      }
    })

  if (!updated.stats.updated) throw fail('棋盘刚变过，再看一眼')

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function respondUndo(uid, roomId, accept) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'playing') throw fail('这局已经结束了')

  const request = room.undoRequest
  if (!request) throw fail('悔棋请求已经失效了')
  if (request.by === uid) throw fail('等对方回应就好')
  if (room.playerIds.indexOf(uid) < 0) throw fail('你不在这个房间里')

  if (!accept) {
    const rejected = await rooms
      .where({ _id: roomId, status: 'playing', version: room.version })
      .update({
        data: { undoRequest: null, updatedAt: Date.now(), version: _.inc(1) }
      })
    if (!rejected.stats.updated) throw fail('棋盘刚变过，再看一眼')
    const fresh = await rooms.doc(roomId).get()
    return { ok: true, room: fresh.data, accepted: false }
  }

  const history = room.history || []
  const last = history[history.length - 1]
  if (!last) throw fail('没有可以撤回的棋子')
  if (!room.lastMove || room.lastMove.x !== last.x || room.lastMove.y !== last.y) {
    throw fail('棋盘已经变化，这次悔棋失效了')
  }

  const board = room.board.slice()
  board[last.y * SIZE + last.x] = 0
  const nextHistory = history.slice(0, -1)
  const prev = nextHistory.length ? nextHistory[nextHistory.length - 1] : null

  const updated = await rooms
    .where({ _id: roomId, status: 'playing', moveCount: room.moveCount })
    .update({
      data: {
        board: board,
        history: nextHistory,
        undoRequest: null,
        moveCount: Math.max(0, (room.moveCount || 0) - 1),
        turn: last.color,
        lastMove: _.set(prev),
        updatedAt: Date.now(),
        version: _.inc(1)
      }
    })

  if (!updated.stats.updated) throw fail('棋盘刚变过，再看一眼')

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data, accepted: true }
}

async function cancelUndo(uid, roomId) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (!room.undoRequest) return { ok: true, room: room }
  if (room.undoRequest.by !== uid) throw fail('这次悔棋不是发起的')

  await rooms
    .where({ _id: roomId, version: room.version })
    .update({
      data: { undoRequest: null, updatedAt: Date.now(), version: _.inc(1) }
    })

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

const EMOTE_KEYS = ['hurry', 'smug', 'plead', 'hug', 'think', 'win']

async function sendEmote(uid, roomId, key) {
  if (EMOTE_KEYS.indexOf(key) < 0) throw fail('没有这个表情')

  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'playing') throw fail('对局中才能发表情')

  const seat = room.playerIds.indexOf(uid)
  if (seat < 0) throw fail('你不在这个房间里')
  const color = room.players[seat].color

  const now = Date.now()
  if (room.emote && now - (room.emote.at || 0) < 700) throw fail('慢一点，一次发一个')

  await rooms.doc(roomId).update({
    data: {
      emote: _.set({ by: uid, color: color, key: key, at: now }),
      updatedAt: now,
      version: _.inc(1)
    }
  })

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function sendHint(uid, roomId, x, y) {
  x = Number(x)
  y = Number(y)
  if (!(x >= 0 && x < SIZE && y >= 0 && y < SIZE)) throw fail('位置不对')

  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'playing') throw fail('对局中才能指路')

  const seat = room.playerIds.indexOf(uid)
  if (seat < 0) throw fail('你不在这个房间里')
  const color = room.players[seat].color

  if (room.board[y * SIZE + x] !== 0) throw fail('这里已经有子了')

  const now = Date.now()
  if (room.hint && now - (room.hint.at || 0) < 1200) throw fail('慢一点')

  await rooms.doc(roomId).update({
    data: {
      hint: _.set({ x: x, y: y, by: uid, color: color, at: now }),
      updatedAt: now,
      version: _.inc(1)
    }
  })

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function resign(uid, roomId) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) throw fail('房间不存在')
  if (room.status !== 'playing') return { ok: true, room: room }

  const seat = room.playerIds.indexOf(uid)
  if (seat < 0) throw fail('你不在这个房间里')
  const mine = room.players[seat].color
  const winner = mine === 'black' ? 'white' : 'black'

  await rooms
    .where({ _id: roomId, status: 'playing', version: room.version })
    .update({
      data: {
        status: 'finished',
        winner: winner,
        endReason: 'resign',
        turn: '',
        undoRequest: null,
        updatedAt: Date.now(),
        version: _.inc(1)
      }
    })

  const fresh = await rooms.doc(roomId).get()
  return { ok: true, room: fresh.data }
}

async function leaveRoom(uid, roomId) {
  const res = await rooms.doc(roomId).get().catch(function () { return null })
  const room = res && res.data ? res.data : null
  if (!room) return { ok: true }
  if (room.playerIds.indexOf(uid) < 0) return { ok: true }

  if (room.status === 'waiting') {
    await rooms.doc(roomId).update({
      data: { status: 'closed', updatedAt: Date.now(), version: _.inc(1) }
    })
  }
  return { ok: true }
}

async function mine(uid) {
  const now = Date.now()
  const res = await rooms
    .where({ playerIds: uid, status: _.in(ACTIVE) })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get()

  const room = res.data[0]

  if (room) {
    if (now - (room.updatedAt || 0) > ROOM_TTL) {
      await rooms.doc(room._id).update({
        data: { status: 'closed', updatedAt: now, version: _.inc(1) }
      })
      return { ok: true, room: null }
    }
    return { ok: true, room: room, seat: room.playerIds.indexOf(uid) }
  }

  const recent = await rooms
    .where({ playerIds: uid, status: 'finished' })
    .orderBy('updatedAt', 'desc')
    .limit(1)
    .get()

  const lastRoom = recent.data[0]
  if (!lastRoom) return { ok: true, room: null }

  if (now - (lastRoom.updatedAt || 0) > FINISHED_TTL) {
    await rooms.doc(lastRoom._id).update({
      data: { status: 'closed', updatedAt: now, version: _.inc(1) }
    })
    return { ok: true, room: null }
  }

  return { ok: true, room: lastRoom, seat: lastRoom.playerIds.indexOf(uid), revisitable: true }
}

function isMissingCollection(err) {
  const msg = (err && (err.errMsg || err.message)) || ''
  return msg.indexOf('collection not exists') >= 0 || msg.indexOf('-502005') >= 0
}

function errorResult(err) {
  const msg = err && (err.errMsg || err.message)
  return { ok: false, error: (err && err.expected) ? err.message : (msg || '服务开小差了') }
}

async function runAction(action, event, uid) {
  switch (action) {
    case 'whoami':
      return { ok: true, uid: uid }
    case 'init': {
      let created = false
      try {
        await db.createCollection('rooms')
        created = true
      } catch (e) {}
      return { ok: true, created: created }
    }
    case 'create':
      return await createRoom(uid)
    case 'join':
      return await joinRoom(uid, event.code)
    case 'get':
      return await getRoom(uid, event.roomId, event.code)
    case 'place':
      return await placeStone(uid, event.roomId, event.x, event.y)
    case 'rematch':
      return await rematch(uid, event.roomId)
    case 'resign':
      return await resign(uid, event.roomId)
    case 'requestUndo':
      return await requestUndo(uid, event.roomId)
    case 'respondUndo':
      return await respondUndo(uid, event.roomId, !!event.accept)
    case 'cancelUndo':
      return await cancelUndo(uid, event.roomId)
    case 'sendEmote':
      return await sendEmote(uid, event.roomId, event.key)
    case 'sendHint':
      return await sendHint(uid, event.roomId, event.x, event.y)
    case 'leave':
      return await leaveRoom(uid, event.roomId)
    case 'mine':
      return await mine(uid)
    default:
      return { ok: false, error: '未知操作' }
  }
}

exports.main = async function (event) {
  const ctx = cloud.getWXContext()
  const OPENID = ctx.OPENID
  if (!OPENID) return { ok: false, error: '没有拿到用户身份' }

  const uid = uidOf(OPENID)
  const action = event.action || ''

  try {
    return await runAction(action, event, uid)
  } catch (e) {
    if (!isMissingCollection(e)) return errorResult(e)

    // 第一次运行时不要求先去控制台建表：自动创建后重试一次
    try {
      await db.createCollection('rooms')
    } catch (e2) {}

    try {
      return await runAction(action, event, uid)
    } catch (e3) {
      return errorResult(e3)
    }
  }
}
