function normalizeError(err) {
  const msg = err && (err.errMsg || err.message) ? (err.errMsg || err.message) : ''
  if (msg.indexOf('FunctionName') >= 0 || msg.indexOf('not found') >= 0) {
    return '云函数还没部署'
  }
  if (msg.indexOf('cloud') >= 0 || msg.indexOf('network') >= 0 || msg.indexOf('timeout') >= 0) {
    return '网络不太稳定，再试一次'
  }
  return msg || '出了点小问题'
}

function call(action, data) {
  return new Promise(function (resolve, reject) {
    wx.cloud
      .callFunction({
        name: 'gomoku',
        data: Object.assign({ action: action }, data || {})
      })
      .then(function (res) {
        const result = res.result || {}
        if (result.ok) {
          resolve(result)
        } else {
          const msg = result.error || '出了点小问题'
          console.error('[cloud]', action, 'failed:', msg)
          reject(new Error(msg))
        }
      })
      .catch(function (err) {
        console.error('[cloud]', action, err)
        reject(new Error(normalizeError(err)))
      })
  })
}

module.exports = { call: call }
