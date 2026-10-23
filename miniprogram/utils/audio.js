const SRC = {
  bgm: '/assets/audio/bgm.mp3',
  place: '/assets/audio/place.mp3',
  place_op: '/assets/audio/place_op.mp3',
  tap: '/assets/audio/tap.mp3',
  win: '/assets/audio/win.mp3',
  lose: '/assets/audio/lose.mp3',
  draw: '/assets/audio/draw.mp3',
  msg: '/assets/audio/msg.mp3'
}

const KEY = 'audio_pref'
// 音乐本身已经做得很轻（rms ≈ 0.09），这里再压一点，确保是"背景"
const BGM_VOLUME = 0.4
const POOL_SIZE = 3

let pref = { bgm: true, sfx: true }
let bgm = null
let unlocked = false
let bgmWanted = false
let bgmPlaying = false
const pool = {}

function loadPref() {
  try {
    const v = wx.getStorageSync(KEY)
    if (v) pref = { bgm: v.bgm !== false, sfx: v.sfx !== false }
  } catch (e) {
    pref = { bgm: true, sfx: true }
  }
  return pref
}

function savePref() {
  try {
    wx.setStorageSync(KEY, pref)
  } catch (e) {}
}

function ensureBgm() {
  if (bgm) return bgm
  bgm = wx.createInnerAudioContext()
  bgm.src = SRC.bgm
  bgm.loop = true
  bgm.volume = BGM_VOLUME
  bgm.autoplay = false
  bgm.onError(function (e) {
    bgmPlaying = false
    console.warn('[audio] 背景音乐播放失败', e && e.errMsg)
  })
  bgm.onStop(function () {
    bgmPlaying = false
  })
  return bgm
}

function acquire(name) {
  const item = pool[name] || (pool[name] = { list: [], idx: 0 })
  if (item.list.length < POOL_SIZE) {
    const ctx = wx.createInnerAudioContext()
    ctx.src = SRC[name]
    ctx.onError(function (e) {
      console.warn('[audio] 音效播放失败', name, e && e.errMsg)
    })
    item.list.push(ctx)
    return ctx
  }
  const ctx = item.list[item.idx % item.list.length]
  item.idx++
  return ctx
}

// 音效播放：音效池轮转，避免连点时互相打断
function play(name, volume) {
  if (!pref.sfx || name === 'bgm' || !SRC[name]) return
  try {
    const ctx = acquire(name)
    ctx.volume = volume === undefined ? 0.6 : volume
    ctx.stop()
    ctx.play()
  } catch (e) {
    console.warn('[audio] play failed', name, e)
  }
}

// iOS 不允许自动播放：必须在用户手势（tap）链里调用一次
function unlock() {
  unlocked = true
  if (bgmWanted && pref.bgm && !bgmPlaying) startBgm()
}

function startBgm() {
  bgmWanted = true
  if (!pref.bgm || !unlocked || bgmPlaying) return
  try {
    ensureBgm().play()
    bgmPlaying = true
  } catch (e) {
    console.warn('[audio] bgm play failed', e)
  }
}

function pauseBgm() {
  if (!bgm) return
  try {
    bgm.pause()
  } catch (e) {}
  bgmPlaying = false
}

function stopBgm() {
  bgmWanted = false
  pauseBgm()
}

function setBgm(on) {
  pref.bgm = !!on
  savePref()
  if (pref.bgm) startBgm()
  else stopBgm()
  return pref
}

function setSfx(on) {
  pref.sfx = !!on
  savePref()
  return pref
}

function toggleAll() {
  const anyOn = pref.bgm || pref.sfx
  setBgm(!anyOn)
  setSfx(!anyOn)
  return pref
}

function anyOn() {
  return pref.bgm || pref.sfx
}

// 小程序切后台/切前台
function pauseAll() {
  pauseBgm()
}

function resumeAll() {
  if (bgmWanted && pref.bgm && unlocked && !bgmPlaying) startBgm()
}

function init() {
  loadPref()
  try {
    wx.setInnerAudioOption({ obeyMuteSwitch: true })
  } catch (e) {}
  return pref
}

module.exports = {
  init: init,
  unlock: unlock,
  play: play,
  startBgm: startBgm,
  pauseBgm: pauseBgm,
  setBgm: setBgm,
  setSfx: setSfx,
  toggleAll: toggleAll,
  anyOn: anyOn,
  getPref: function () {
    return pref
  },
  pauseAll: pauseAll,
  resumeAll: resumeAll
}
