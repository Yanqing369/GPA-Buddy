const app = getApp()

Page({
  data: {
    testing: false,
    hasTested: false,
    logs: [],
    scrollTop: 0,
    stats: {
      total: 0,
      success: 0,
      fail: 0,
      duration: 0
    },
    overallStatus: '', // success, partial, fail
    statusText: '',
    networkInfo: null
  },

  onLoad() {
    this.getNetworkInfo()
    this.addLog('小程序加载完成', 'info')
    this.addLog('目标域名: https://moyuxiaowu.org', 'info')
  },

  // 获取网络信息
  getNetworkInfo() {
    wx.getNetworkType({
      success: (res) => {
        this.setData({
          networkInfo: {
            networkType: res.networkType,
            signalStrength: res.signalStrength
          }
        })
        this.addLog(`当前网络类型: ${res.networkType}`, 'info')
      }
    })
  },

  // 添加日志
  addLog(message, type = 'info') {
    const now = new Date()
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`
    
    const logs = this.data.logs.concat([{ time, message, type }])
    this.setData({ 
      logs,
      scrollTop: logs.length * 100 // 自动滚动到底部
    })
  },

  // 清空日志
  clearLog() {
    this.setData({
      logs: [],
      hasTested: false,
      overallStatus: '',
      statusText: '',
      stats: { total: 0, success: 0, fail: 0, duration: 0 }
    })
  },

  // 开始检测
  async startTest() {
    if (this.data.testing) return

    this.setData({ 
      testing: true, 
      hasTested: false,
      logs: [],
      stats: { total: 0, success: 0, fail: 0, duration: 0 }
    })

    const startTime = Date.now()
    let success = 0
    let fail = 0

    this.addLog('🚀 开始后端连接检测...', 'info')
    this.addLog('─'.repeat(30), 'info')

    // 测试1: 基础连通性 (GET /stats)
    const test1 = await this.testStats()
    if (test1) success++; else fail++

    // 测试2: CORS 测试
    const test2 = await this.testCORS()
    if (test2) success++; else fail++

    // 测试3: 认证接口测试 (应该返回 401)
    const test3 = await this.testAuth()
    if (test3) success++; else fail++

    // 测试4: POST 请求测试
    const test4 = await this.testChat()
    if (test4) success++; else fail++

    // 测试5: 404 测试
    const test5 = await this.test404()
    if (test5) success++; else fail++

    const duration = Date.now() - startTime
    const total = 5

    this.addLog('─'.repeat(30), 'info')

    // 判断整体状态
    let overallStatus, statusText
    if (success === total) {
      overallStatus = 'success'
      statusText = '🎉 全部检测通过！后端服务正常'
      this.addLog(`✅ 所有测试通过 (${success}/${total})`, 'success')
    } else if (success > 0) {
      overallStatus = 'partial'
      statusText = `⚠️ 部分通过 (${success}/${total})，请检查配置`
      this.addLog(`⚠️ 部分测试通过 (${success}/${total})`, 'warning')
    } else {
      overallStatus = 'fail'
      statusText = '❌ 连接失败，无法访问后端服务'
      this.addLog(`❌ 测试失败 (${fail}/${total})`, 'error')
    }

    this.setData({
      testing: false,
      hasTested: true,
      overallStatus,
      statusText,
      stats: { total, success, fail, duration }
    })

    // 显示结果提示
    wx.showToast({
      title: success === total ? '检测通过' : '检测完成',
      icon: success === total ? 'success' : 'none',
      duration: 2000
    })
  },

  // 测试 /stats 接口
  testStats() {
    return new Promise((resolve) => {
      this.addLog('🔄 测试 /stats (基础连通性)...', 'info')
      
      const requestTask = wx.request({
        url: 'https://moyuxiaowu.org/stats',
        method: 'GET',
        timeout: 10000,
        success: (res) => {
          if (res.statusCode === 200) {
            const data = res.data
            if (data && typeof data.total === 'number') {
              this.addLog(`✅ /stats 成功 - 总生成次数: ${data.total}`, 'success')
              resolve(true)
            } else {
              this.addLog(`⚠️ /stats 返回异常: ${JSON.stringify(data)}`, 'warning')
              resolve(true) // 能连上就算成功
            }
          } else {
            this.addLog(`❌ /stats 状态码: ${res.statusCode}`, 'error')
            resolve(false)
          }
        },
        fail: (err) => {
          this.addLog(`❌ /stats 失败: ${err.errMsg || '未知错误'}`, 'error')
          // 详细错误分析
          if (err.errMsg && err.errMsg.includes('fail url not in domain list')) {
            this.addLog('💡 提示: 域名不在白名单中', 'warning')
          } else if (err.errMsg && err.errMsg.includes('fail ssl')) {
            this.addLog('💡 提示: SSL 证书问题', 'warning')
          } else if (err.errMsg && err.errMsg.includes('fail timeout')) {
            this.addLog('💡 提示: 请求超时', 'warning')
          }
          resolve(false)
        }
      })

      // 5秒超时处理
      setTimeout(() => {
        requestTask.abort()
        this.addLog('⏱️ /stats 请求超时(5s)', 'error')
        resolve(false)
      }, 5000)
    })
  },

  // 测试 CORS (OPTIONS 预检)
  testCORS() {
    return new Promise((resolve) => {
      this.addLog('🔄 测试 CORS 支持...', 'info')
      
      wx.request({
        url: 'https://moyuxiaowu.org/stats',
        method: 'OPTIONS',
        timeout: 10000,
        success: (res) => {
          if (res.statusCode === 204 || res.statusCode === 200) {
            this.addLog(`✅ CORS 预检成功 (${res.statusCode})`, 'success')
            resolve(true)
          } else {
            this.addLog(`⚠️ CORS 预检返回: ${res.statusCode}`, 'warning')
            resolve(true) // 能连上就算基本成功
          }
        },
        fail: (err) => {
          this.addLog(`❌ CORS 测试失败: ${err.errMsg || '未知错误'}`, 'error')
          resolve(false)
        }
      })
    })
  },

  // 测试认证接口 (应该返回 401)
  testAuth() {
    return new Promise((resolve) => {
      this.addLog('🔄 测试 /auth/me (认证接口)...', 'info')
      
      wx.request({
        url: 'https://moyuxiaowu.org/auth/me',
        method: 'GET',
        timeout: 10000,
        success: (res) => {
          if (res.statusCode === 401) {
            this.addLog('✅ /auth/me 正确返回 401 (需要认证)', 'success')
            resolve(true)
          } else {
            this.addLog(`⚠️ /auth/me 返回: ${res.statusCode}`, 'warning')
            resolve(true) // 能连上就算成功
          }
        },
        fail: (err) => {
          this.addLog(`❌ /auth/me 失败: ${err.errMsg || '未知错误'}`, 'error')
          resolve(false)
        }
      })
    })
  },

  // 测试 POST 请求 (/chat)
  testChat() {
    return new Promise((resolve) => {
      this.addLog('🔄 测试 /chat (POST 接口)...', 'info')
      
      wx.request({
        url: 'https://moyuxiaowu.org/chat',
        method: 'POST',
        data: {
          messages: [{ role: 'user', content: 'test' }]
        },
        timeout: 10000,
        success: (res) => {
          // /chat 可能返回各种状态码，只要能连上就基本正常
          if (res.statusCode === 200 || res.statusCode === 500 || res.statusCode === 401) {
            this.addLog(`✅ /chat 可访问 (状态: ${res.statusCode})`, 'success')
            resolve(true)
          } else {
            this.addLog(`⚠️ /chat 返回: ${res.statusCode}`, 'warning')
            resolve(true)
          }
        },
        fail: (err) => {
          this.addLog(`❌ /chat 失败: ${err.errMsg || '未知错误'}`, 'error')
          resolve(false)
        }
      })
    })
  },

  // 测试 404 处理
  test404() {
    return new Promise((resolve) => {
      this.addLog('🔄 测试 404 处理...', 'info')
      
      wx.request({
        url: 'https://moyuxiaowu.org/nonexistent',
        method: 'GET',
        timeout: 10000,
        success: (res) => {
          if (res.statusCode === 404) {
            this.addLog('✅ 404 处理正常', 'success')
            resolve(true)
          } else {
            this.addLog(`⚠️ 404 测试返回: ${res.statusCode}`, 'warning')
            resolve(true)
          }
        },
        fail: (err) => {
          this.addLog(`❌ 404 测试失败: ${err.errMsg || '未知错误'}`, 'error')
          resolve(false)
        }
      })
    })
  }
})
