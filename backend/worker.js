/**
 * Worker - GCS + Vertex AI + 用户登录系统
 * 架构：上传 → 并行生成 → 最后统一清理
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Visitor-ID',
};

function getCorsHeaders(request) {
  const origin = request?.headers?.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Visitor-ID',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/* ==================== RATE LIMITING ==================== */
// 简易内存级限流（每个 Worker 实例独立）
function createResponse(body, status = 200, request = null) {
  return new Response(body, {
    status,
    headers: {
      ...(request ? getCorsHeaders(request) : corsHeaders),
      'Content-Type': 'application/json',
    },
  });
}

function handleOptions(request) {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}

/* ==================== JWT & AUTH ==================== */

// 基于 Web Crypto API 的 JWT 签名和验证
async function signJWT(payload, secret) {
  const encoder = new TextEncoder();
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = btoa(JSON.stringify(header)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  
  const data = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  
  return `${data}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  try {
    const [headerB64, payloadB64, signatureB64] = token.split('.');
    if (!headerB64 || !payloadB64 || !signatureB64) return null;
    
    const encoder = new TextEncoder();
    const data = `${headerB64}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(data));
    
    if (!valid) return null;
    
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    
    return payload;
  } catch (e) {
    return null;
  }
}

// 从请求中提取 token（支持 Bearer header 或 Cookie）
function getTokenFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/token=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

// 从请求中提取用户信息
async function getUserFromRequest(request, env) {
  const token = getTokenFromRequest(request);
  if (!token) {
    console.log('No Authorization header or Cookie token found');
    return null;
  }
  
  console.log('Verifying JWT token...');
  
  if (!env.JWT_SECRET) {
    console.error('JWT_SECRET not configured');
    return null;
  }
  
  const payload = await verifyJWT(token, env.JWT_SECRET);
  if (!payload) {
    console.log('JWT verification failed');
    return null;
  }
  
  console.log('JWT payload:', JSON.stringify(payload));
  
  // 从数据库获取完整用户信息
  try {
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(payload.userId)
      .first();
    
    if (!user) {
      console.log('User not found in database:', payload.userId);
    } else {
      console.log('User found:', user.email);
    }
    
    return user;
  } catch (dbError) {
    console.error('Database error:', dbError);
    return null;
  }
}

/* ==================== PASSWORD HASHING (PBKDF2) ==================== */

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    256
  );
  return { hash: Array.from(new Uint8Array(key)), salt: Array.from(salt) };
}

async function verifyPassword(password, storedHash, storedSalt) {
  const key = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new Uint8Array(storedSalt), iterations: 100000, hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    256
  );
  const hash = Array.from(new Uint8Array(key));
  return hash.length === storedHash.length && hash.every((v, i) => v === storedHash[i]);
}

/* ==================== GOOGLE OAUTH ==================== */

async function handleGoogleLogin(request, env) {
  const url = new URL(request.url);
  const frontendRedirectUri = url.searchParams.get('redirectUri');
  const redirectUri = frontendRedirectUri || getRedirectUri(request, env);
  const state = generateState();
  
  // 获取用户来源页面，用于登录后跳转回去
  const referer = request.headers.get('Referer') || '';
  
  // 读取前端传入的 visitorId 和 invite code
  const visitorId = url.searchParams.get('visitorId') || '';
  const inviteCode = url.searchParams.get('inviter') || '';
  
  // 存储state和referer到KV（5分钟过期）
  await env.EXAM_STATS.put(`oauth_state:${state}`, JSON.stringify({ 
    redirectUri, 
    referer,
    visitorId,
    inviteCode
  }), { expirationTtl: 300 });
  
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
  });
  
  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  
  // 如果前端传了 redirectUri，返回 JSON（新流程：前端域名回调）
  if (frontendRedirectUri) {
    return createResponse(JSON.stringify({ url: googleUrl, state }));
  }
  
  // 兼容旧流程：直接重定向到 Google
  return Response.redirect(googleUrl, 302);
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  
  if (error) {
    return createResponse(JSON.stringify({ error: 'OAuth cancelled' }), 400);
  }
  
  // 验证state
  const stateData = await env.EXAM_STATS.get(`oauth_state:${state}`);
  if (!stateData) {
    return createResponse(JSON.stringify({ error: 'Invalid or expired state' }), 400);
  }
  await env.EXAM_STATS.delete(`oauth_state:${state}`);
  
  const { redirectUri, referer, visitorId, inviteCode } = JSON.parse(stateData);
  
  // 动态判断前端URL（支持本地开发）
  const frontendUrl = getFrontendUrl(request, env, referer);
  
  // 交换code获取access_token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return createResponse(JSON.stringify({ error: 'Failed to get access token' }), 400);
  }
  
  // 获取用户信息
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  
  const googleUser = await userRes.json();
  
  // 查找或创建用户
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
    .bind(googleUser.id)
    .first();
  
  let isNewUser = false;
  
  if (!user) {
    isNewUser = true;
    // 创建新用户（带邀请码）
    const invitationCode = generateInvitationCode();
    const result = await env.DB.prepare(
      'INSERT INTO users (email, name, avatar, google_id, account_type, invitation_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(googleUser.email, googleUser.name, googleUser.picture, googleUser.id, 'free', invitationCode).run();
    
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();
    
    // 初始化余额记录
    await env.DB.prepare(
      'INSERT INTO balances (user_id, amount, free_quota_daily, free_quota_used, last_reset_date) VALUES (?, 0, 0, 0, date("now"))'
    ).bind(user.id).run();
  } else {
    // 更新最后登录时间
    await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?')
      .bind(user.id).run();
    
    // 老用户如果没有邀请码，补生成一个
    if (!user.invitation_code) {
      const code = generateInvitationCode();
      await env.DB.prepare('UPDATE users SET invitation_code = ? WHERE id = ?')
        .bind(code, user.id).run();
      user.invitation_code = code;
    }
  }
  
  // ========== 合并 visitor credits ==========
  let mergedAmount = 0;
  if (visitorId) {
    const visitor = await env.DB.prepare(
      'SELECT * FROM visitors WHERE visitor_id = ? AND linked_user_id IS NULL'
    ).bind(visitorId).first();
    
    if (visitor) {
      const mergeAmount = visitor.credits || 0;
      const bonus = isNewUser ? 20 : 0;
      const totalAdd = mergeAmount + bonus;
      
      if (totalAdd > 0) {
        mergedAmount = totalAdd;
        // 原子清零并绑定 visitor
        await env.DB.prepare(
          'UPDATE visitors SET credits = 0, linked_user_id = ? WHERE visitor_id = ? AND linked_user_id IS NULL'
        ).bind(user.id, visitorId).run();
        
        // 加到 user balance
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(totalAdd, user.id).run();
      } else if (bonus > 0) {
        mergedAmount = bonus;
        // visitor credits 为 0，但新用户有注册奖励
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(bonus, user.id).run();
      }
    }
  }
  
  // ========== 处理邀请关系 ==========
  let inviteBonus = 0;
  let inviterName = '';
  if (inviteCode && user.inviter === null) {
    const inviter = await env.DB.prepare(
      'SELECT * FROM users WHERE invitation_code = ?'
    ).bind(inviteCode).first();
    
    if (inviter && inviter.id !== user.id) {
      inviteBonus = 20;
      inviterName = inviter.name || inviter.email || '';
      // 绑定邀请关系
      await env.DB.prepare(
        'UPDATE users SET inviter = ? WHERE id = ? AND inviter IS NULL'
      ).bind(inviter.id, user.id).run();
      
      // 被邀请人 +20
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(user.id).run();
      
      // 邀请人 +20
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(inviter.id).run();
    }
  }
  
  // 生成JWT
  const jwt = await signJWT(
    { userId: user.id, email: user.email, type: user.account_type },
    env.JWT_SECRET
  );
  
  // 重定向到前端首页，带上token
  const inviteParam = inviteBonus > 0 ? `&inviteBonus=${inviteBonus}&inviterName=${encodeURIComponent(inviterName)}` : '';
  return Response.redirect(`${frontendUrl}/index.html?login=success&token=${jwt}&merged=${mergedAmount}${inviteParam}`, 302);
}

async function handleGoogleExchange(request, env) {
  const body = await request.json();
  const { code, redirectUri, visitorId, inviteCode, state } = body;
  
  if (!code || !redirectUri || !state) {
    return createResponse(JSON.stringify({ error: 'Missing code, redirectUri or state' }), 400, request);
  }
  
  // 验证state
  const stateData = await env.EXAM_STATS.get(`oauth_state:${state}`);
  if (!stateData) {
    return createResponse(JSON.stringify({ error: 'Invalid or expired state' }), 400, request);
  }
  await env.EXAM_STATS.delete(`oauth_state:${state}`);
  
  // 交换code获取access_token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return createResponse(JSON.stringify({ error: 'Failed to get access token' }), 400, request);
  }
  
  // 获取用户信息
  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  
  const googleUser = await userRes.json();
  
  // 查找或创建用户
  let user = await env.DB.prepare('SELECT * FROM users WHERE google_id = ?')
    .bind(googleUser.id)
    .first();
  
  let isNewUser = false;
  
  if (!user) {
    isNewUser = true;
    // 创建新用户（带邀请码）
    const invitationCode = generateInvitationCode();
    const result = await env.DB.prepare(
      'INSERT INTO users (email, name, avatar, google_id, account_type, invitation_code) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(googleUser.email, googleUser.name, googleUser.picture, googleUser.id, 'free', invitationCode).run();
    
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();
    
    // 初始化余额记录
    await env.DB.prepare(
      'INSERT INTO balances (user_id, amount, free_quota_daily, free_quota_used, last_reset_date) VALUES (?, 0, 0, 0, date("now"))'
    ).bind(user.id).run();
  } else {
    // 更新最后登录时间
    await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?')
      .bind(user.id).run();
    
    // 老用户如果没有邀请码，补生成一个
    if (!user.invitation_code) {
      const code = generateInvitationCode();
      await env.DB.prepare('UPDATE users SET invitation_code = ? WHERE id = ?')
        .bind(code, user.id).run();
      user.invitation_code = code;
    }
  }
  
  // ========== 合并 visitor credits ==========
  let mergedAmount = 0;
  if (visitorId) {
    const visitor = await env.DB.prepare(
      'SELECT * FROM visitors WHERE visitor_id = ? AND linked_user_id IS NULL'
    ).bind(visitorId).first();
    
    if (visitor) {
      const mergeAmount = visitor.credits || 0;
      const bonus = isNewUser ? 20 : 0;
      const totalAdd = mergeAmount + bonus;
      
      if (totalAdd > 0) {
        mergedAmount = totalAdd;
        // 原子清零并绑定 visitor
        await env.DB.prepare(
          'UPDATE visitors SET credits = 0, linked_user_id = ? WHERE visitor_id = ? AND linked_user_id IS NULL'
        ).bind(user.id, visitorId).run();
        
        // 加到 user balance
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(totalAdd, user.id).run();
      } else if (bonus > 0) {
        mergedAmount = bonus;
        // visitor credits 为 0，但新用户有注册奖励
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(bonus, user.id).run();
      }
    }
  }
  
  // ========== 处理邀请关系 ==========
  let inviteBonus = 0;
  let inviterName = '';
  if (inviteCode && user.inviter === null) {
    const inviter = await env.DB.prepare(
      'SELECT * FROM users WHERE invitation_code = ?'
    ).bind(inviteCode).first();
    
    if (inviter && inviter.id !== user.id) {
      inviteBonus = 20;
      inviterName = inviter.name || inviter.email || '';
      // 绑定邀请关系
      await env.DB.prepare(
        'UPDATE users SET inviter = ? WHERE id = ? AND inviter IS NULL'
      ).bind(inviter.id, user.id).run();
      
      // 被邀请人 +20
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(user.id).run();
      
      // 邀请人 +20
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(inviter.id).run();
    }
  }
  
  // 生成JWT
  const jwt = await signJWT(
    { userId: user.id, email: user.email, type: user.account_type },
    env.JWT_SECRET
  );
  
  // 获取余额信息
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(user.id)
    .first();
  
  return createResponse(JSON.stringify({
    token: jwt,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
      accountType: user.account_type,
      invitationCode: user.invitation_code,
      balance: balance ? {
        amount: balance.amount,
        freeQuotaDaily: balance.free_quota_daily,
        freeQuotaUsed: balance.free_quota_used,
        freeQuotaLeft: Math.max(0, balance.free_quota_daily - balance.free_quota_used),
      } : null,
    },
    mergedAmount,
    inviteBonus,
    inviterName,
  }), 200, request);
}

function generateState() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateInvitationCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return Array.from(array, b => chars[b % chars.length]).join('');
}

function generateEmailCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* ==================== EMAIL AUTH CONFIG ==================== */
const TEST_ACCOUNTS = {
  'test1@gpa-buddy.com': 'PCG123456',
  'test2@gpa-buddy.com': 'PCG123456',
};

const DEFAULT_AVATARS = [
  '/resources/avatar1.png',
  '/resources/avatar2.png',
  '/resources/avatar3.png',
  '/resources/avatar4.png',
];

const TEST_AVATAR = '/resources/avatar6.png';

/* ==================== COOKIE HELPERS ==================== */

function createCookieResponse(body, token, status = 200, request = null) {
  return new Response(body, {
    status,
    headers: {
      ...(request ? getCorsHeaders(request) : corsHeaders),
      'Content-Type': 'application/json',
      'Set-Cookie': `token=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`,
    },
  });
}

function clearCookieResponse(body, status = 200, request = null) {
  return new Response(body, {
    status,
    headers: {
      ...(request ? getCorsHeaders(request) : corsHeaders),
      'Content-Type': 'application/json',
      'Set-Cookie': `token=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
  });
}

/* ==================== EMAIL OTP ==================== */

async function sendEmailViaAoksend(email, code, env) {
  if (!env.AOKSEND_APP_KEY || !env.AOKSEND_TEMPLATE_ID) {
    throw new Error('AOKSEND_APP_KEY or AOKSEND_TEMPLATE_ID not configured');
  }
  const form = new FormData();
  form.append('app_key', env.AOKSEND_APP_KEY);
  form.append('template_id', env.AOKSEND_TEMPLATE_ID);
  form.append('to', email);
  form.append('data', JSON.stringify({ code }));
  const res = await fetch('https://apiv2.aoksend.com/index/api/send_email', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  if (data.code !== 200) {
    throw new Error(data.message || 'Email send failed');
  }
  return data;
}

// 邮箱级别限流：内存级，每个 Worker 实例独立
const emailCodeRateLimit = new Map();
const EMAIL_COOLDOWN_MS = 60 * 1000; // 60 秒

function checkEmailRateLimit(email) {
  const now = Date.now();
  const record = emailCodeRateLimit.get(email);
  if (record) {
    if (now - record.lastSent < EMAIL_COOLDOWN_MS) {
      const retryAfter = Math.ceil((EMAIL_COOLDOWN_MS - (now - record.lastSent)) / 1000);
      return { allowed: false, retryAfter };
    }
  }
  return { allowed: true };
}

function recordEmailSent(email) {
  emailCodeRateLimit.set(email, { lastSent: Date.now() });
}

async function handleEmailSendCode(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();

  // 邮箱格式校验
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return createResponse(JSON.stringify({ error: 'Invalid email format' }), 400, request);
  }

  // 邮箱级别限流
  const rl = checkEmailRateLimit(email);
  if (!rl.allowed) {
    return createResponse(JSON.stringify({ error: 'Too frequent', retryAfter: rl.retryAfter }), 429, request);
  }

  let code;

  // 测试账户短路：固定验证码，不发真实邮件
  if (TEST_ACCOUNTS[email]) {
    code = TEST_ACCOUNTS[email];
  } else {
    code = generateEmailCode();
    try {
      await sendEmailViaAoksend(email, code, env);
    } catch (err) {
      console.error('Failed to send email:', err);
      return createResponse(JSON.stringify({ error: 'Failed to send email: ' + err.message }), 500, request);
    }
  }

  // 写入 D1（标记旧验证码为已使用，避免混淆）
  await env.DB.prepare(
    'UPDATE email_codes SET used = 1 WHERE email = ? AND used = 0'
  ).bind(email).run();

  await env.DB.prepare(
    'INSERT INTO email_codes (email, code, expires_at) VALUES (?, ?, datetime("now", "+5 minutes"))'
  ).bind(email, code).run();

  recordEmailSent(email);

  return createResponse(JSON.stringify({ success: true, message: 'Code sent' }), 200, request);
}

async function handleEmailVerify(request, env) {
  const body = await request.json();
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  const visitorId = body.visitorId || '';
  const inviteCode = body.inviter || '';

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return createResponse(JSON.stringify({ error: 'Invalid email format' }), 400, request);
  }
  let isTestAccount = false;

  // 测试账户短路
  if (TEST_ACCOUNTS[email] && TEST_ACCOUNTS[email] === code) {
    isTestAccount = true;
  } else {
    if (!/^\d{6}$/.test(code)) {
      return createResponse(JSON.stringify({ error: 'Invalid code format' }), 400, request);
    }

    // 查询有效验证码
    const codeRecord = await env.DB.prepare(
      'SELECT * FROM email_codes WHERE email = ? AND code = ? AND used = 0 AND expires_at > datetime("now") ORDER BY created_at DESC LIMIT 1'
    ).bind(email, code).first();

    if (!codeRecord) {
      return createResponse(JSON.stringify({ error: 'Invalid or expired code' }), 403, request);
    }

    // 标记为已使用
    await env.DB.prepare('UPDATE email_codes SET used = 1 WHERE id = ?').bind(codeRecord.id).run();
  }

  // 查找或创建用户
  let user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    const invitationCode = generateInvitationCode();
    const name = email.split('@')[0] || 'User';
    const avatar = isTestAccount ? TEST_AVATAR : DEFAULT_AVATARS[Math.floor(Math.random() * DEFAULT_AVATARS.length)];
    const result = await env.DB.prepare(
      'INSERT INTO users (email, name, avatar, account_type, invitation_code) VALUES (?, ?, ?, ?, ?)'
    ).bind(email, name, avatar, 'free', invitationCode).run();

    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();

    // 初始化余额
    await env.DB.prepare(
      'INSERT INTO balances (user_id, amount, free_quota_daily, free_quota_used, last_reset_date) VALUES (?, 0, 0, 0, date("now"))'
    ).bind(user.id).run();
  } else {
    // 更新最后登录时间
    await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?')
      .bind(user.id).run();

    // 老用户补邀请码
    if (!user.invitation_code) {
      const code = generateInvitationCode();
      await env.DB.prepare('UPDATE users SET invitation_code = ? WHERE id = ?')
        .bind(code, user.id).run();
      user.invitation_code = code;
    }
  }

  // 合并 visitor credits（复用 Google 登录逻辑）
  let mergedAmount = 0;
  if (visitorId) {
    const visitor = await env.DB.prepare(
      'SELECT * FROM visitors WHERE visitor_id = ? AND linked_user_id IS NULL'
    ).bind(visitorId).first();

    if (visitor) {
      const mergeAmount = visitor.credits || 0;
      const bonus = isNewUser ? 20 : 0;
      const totalAdd = mergeAmount + bonus;

      if (totalAdd > 0) {
        mergedAmount = totalAdd;
        await env.DB.prepare(
          'UPDATE visitors SET credits = 0, linked_user_id = ? WHERE visitor_id = ? AND linked_user_id IS NULL'
        ).bind(user.id, visitorId).run();
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(totalAdd, user.id).run();
      } else if (bonus > 0) {
        mergedAmount = bonus;
        await env.DB.prepare(
          'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
        ).bind(bonus, user.id).run();
      }
    }
  }

  // 处理邀请关系
  let inviteBonus = 0;
  let inviterName = '';
  if (inviteCode && user.inviter === null) {
    const inviter = await env.DB.prepare(
      'SELECT * FROM users WHERE invitation_code = ?'
    ).bind(inviteCode).first();

    if (inviter && inviter.id !== user.id) {
      inviteBonus = 20;
      inviterName = inviter.name || inviter.email || '';
      await env.DB.prepare(
        'UPDATE users SET inviter = ? WHERE id = ? AND inviter IS NULL'
      ).bind(inviter.id, user.id).run();
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(user.id).run();
      await env.DB.prepare(
        'UPDATE balances SET amount = amount + 20 WHERE user_id = ?'
      ).bind(inviter.id).run();
    }
  }

  // 生成 JWT
  const jwt = await signJWT(
    { userId: user.id, email: user.email, type: user.account_type },
    env.JWT_SECRET
  );

  // 获取余额信息
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(user.id)
    .first();

  const userData = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    accountType: user.account_type,
    invitationCode: user.invitation_code,
    balance: balance ? {
      amount: balance.amount,
      freeQuotaDaily: balance.free_quota_daily,
      freeQuotaUsed: balance.free_quota_used,
      freeQuotaLeft: Math.max(0, balance.free_quota_daily - balance.free_quota_used),
    } : null,
  };

  return createCookieResponse(JSON.stringify({ token: jwt, user: userData, mergedAmount: mergedAmount, inviteBonus: inviteBonus, inviterName: inviterName }), jwt, 200, request);
}

function getRedirectUri(request, env) {
  // Worker 的域名用于 OAuth 回调（Google 会回调到这个地址）
  // 这必须与 Google Cloud Console 中配置的 URI 完全匹配
  const workerUrl = new URL(request.url).origin;
  return `${workerUrl}/auth/google/callback`;
}

function getFrontendUrl(request, env, storedReferer) {
  // 优先使用存储的 referer（登录时的来源页面）
  if (storedReferer) {
    try {
      const url = new URL(storedReferer);
      // 只保留协议、主机和端口
      return `${url.protocol}//${url.host}`;
    } catch (e) {
      // 解析失败，继续其他判断
    }
  }
  
  // 检测请求来源
  const referer = request.headers.get('Referer') || '';
  const origin = request.headers.get('Origin') || '';
  
  // 如果是本地开发环境
  if (referer.includes('localhost') || origin.includes('localhost') || 
      referer.includes('127.0.0.1') || origin.includes('127.0.0.1')) {
    // 尝试从 referer 中提取端口
    try {
      const url = new URL(referer || origin);
      return `${url.protocol}//${url.host}`;
    } catch (e) {
      return 'http://localhost:8788';
    }
  }
  
  // 从环境变量获取前端域名（生产环境）
  return env.FRONTEND_URL || 'https://www.gpa-buddy.com';
}

/* ==================== USER API ==================== */

async function handleGetMe(request, env) {
  console.log('handleGetMe called');
  const user = await getUserFromRequest(request, env);
  if (!user) {
    console.log('User not authenticated');
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  console.log('Getting balance for user:', user.id);
  // 获取余额信息
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(user.id)
    .first();
  
  return createResponse(JSON.stringify({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar: user.avatar,
    accountType: user.account_type,
    invitationCode: user.invitation_code,
    lastClaim: user.last_claim,
    balance: balance ? {
      amount: balance.amount,
      freeQuotaDaily: balance.free_quota_daily,
      freeQuotaUsed: balance.free_quota_used,
      freeQuotaLeft: Math.max(0, balance.free_quota_daily - balance.free_quota_used),
    } : null,
  }));
}

async function handleLogout(request, env) {
  // JWT是无状态的，客户端删除token即可；同时清除 Cookie
  return clearCookieResponse(JSON.stringify({ success: true }), 200, request);
}

/* ==================== QUESTION BANK API ==================== */

async function handleGetBanks(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const { results } = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();
  
  return createResponse(JSON.stringify({ banks: results }));
}

async function handleCreateBank(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const body = await request.json();
  const { title, description } = body;
  
  if (!title) {
    return createResponse(JSON.stringify({ error: 'Title is required' }), 400);
  }
  
  // 检查免费用户题库数量限制
  if (user.account_type === 'free') {
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM question_banks WHERE user_id = ?'
    ).bind(user.id).first();
    
    if (count >= 5) {
      return createResponse(JSON.stringify({ 
        error: 'Free users can only create up to 5 question banks. Please upgrade to Pro.' 
      }), 403);
    }
  }
  
  const result = await env.DB.prepare(
    'INSERT INTO question_banks (user_id, title, description) VALUES (?, ?, ?)'
  ).bind(user.id, title, description || '').run();
  
  const bank = await env.DB.prepare('SELECT * FROM question_banks WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first();
  
  return createResponse(JSON.stringify({ bank }));
}

async function handleGetBank(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ? AND user_id = ?'
  ).bind(bankId, user.id).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  // 获取题目列表
  const { results: questions } = await env.DB.prepare(
    'SELECT * FROM questions WHERE bank_id = ? ORDER BY created_at DESC'
  ).bind(bankId).all();
  
  return createResponse(JSON.stringify({ bank, questions }));
}

async function handleSaveQuestions(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const body = await request.json();
  const { questions } = body;
  
  if (!Array.isArray(questions) || questions.length === 0) {
    return createResponse(JSON.stringify({ error: 'Questions array is required' }), 400);
  }
  
  // 验证题库归属
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ? AND user_id = ?'
  ).bind(bankId, user.id).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  // 批量插入题目
  const stmt = env.DB.prepare(
    'INSERT INTO questions (bank_id, type, content, answer, explanation, difficulty, tags) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  
  const batch = questions.map(q => stmt.bind(
    bankId,
    q.type || 'choice',
    q.content,
    q.answer || '',
    q.explanation || '',
    q.difficulty || 1,
    JSON.stringify(q.tags || [])
  ));
  
  await env.DB.batch(batch);
  
  // 更新题库题目数量
  await env.DB.prepare(
    'UPDATE question_banks SET questions_count = questions_count + ?, updated_at = datetime("now") WHERE id = ?'
  ).bind(questions.length, bankId).run();
  
  return createResponse(JSON.stringify({ success: true, count: questions.length }));
}

async function handleDeleteBank(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  // 验证并删除（级联删除题目）
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ? AND user_id = ?'
  ).bind(bankId, user.id).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  await env.DB.prepare('DELETE FROM question_banks WHERE id = ?').bind(bankId).run();
  
  return createResponse(JSON.stringify({ success: true }));
}

/* ==================== R2 HELPERS ==================== */

function sanitizeForR2Key(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_').substring(0, 128);
}

function buildMaterialR2Key(courseId, materialId, filename) {
  const safeName = sanitizeForR2Key(filename || 'material');
  return `courses/${courseId}/materials/${materialId}/${safeName}`;
}

function isTextType(type, name) {
  if (!type && !name) return false;
  const t = (type || '').toLowerCase();
  if (t.startsWith('text/')) return true;
  const n = (name || '').toLowerCase();
  const textExts = ['.txt', '.md', '.markdown', '.json', '.csv'];
  if (textExts.some(ext => n.endsWith(ext))) return true;
  return false;
}

function isPdfType(type, name) {
  const t = (type || '').toLowerCase();
  if (t === 'application/pdf') return true;
  return (name || '').toLowerCase().endsWith('.pdf');
}

async function uploadToR2(file, key, env) {
  await env.MATERIALS_BUCKET.put(key, file);
  return key;
}

async function readR2Text(key, env) {
  try {
    const object = await env.MATERIALS_BUCKET.get(key);
    if (!object) return '';
    return await object.text();
  } catch (e) {
    console.error('[R2] read text failed:', key, e);
    return '';
  }
}

async function readR2Object(key, env) {
  try {
    return await env.MATERIALS_BUCKET.get(key);
  } catch (e) {
    console.error('[R2] get object failed:', key, e);
    return null;
  }
}

/* ==================== COURSE ROUTES ==================== */

async function handleGetCourses(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.created_at, c.updated_at,
      (SELECT COUNT(*) FROM course_materials WHERE course_id = c.id) AS material_count,
      (SELECT COUNT(*) FROM course_questions WHERE course_id = c.id) AS question_count
     FROM courses c
     WHERE c.user_id = ?
     ORDER BY c.updated_at DESC`
  ).bind(user.id).all();

  return createResponse(JSON.stringify({ courses: results }));
}

async function handleCreateCourse(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const body = await request.json();
  const name = (body.name || '').trim();
  if (!name) return createResponse(JSON.stringify({ error: 'Course name is required' }), 400);

  const result = await env.DB.prepare(
    'INSERT INTO courses (user_id, name) VALUES (?, ?)'
  ).bind(user.id, name).run();

  const course = await env.DB.prepare(
    'SELECT id, name, created_at, updated_at FROM courses WHERE id = ?'
  ).bind(result.meta.last_row_id).first();

  return createResponse(JSON.stringify({ course }));
}

async function handleGetCourse(request, env, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id, name, created_at, updated_at FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const { results: materials } = await env.DB.prepare(
    'SELECT id, course_id, name, size, type, content_text, r2_key, analyzed_at, created_at FROM course_materials WHERE course_id = ? ORDER BY created_at DESC'
  ).bind(courseId).all();

  const { results: questions } = await env.DB.prepare(
    'SELECT id, course_id, type, title, content, answer, explanation, difficulty, tags, source_material_id, batch_id, created_at FROM course_questions WHERE course_id = ? ORDER BY created_at DESC'
  ).bind(courseId).all();

  const { results: batches } = await env.DB.prepare(
    'SELECT id, course_id, name, created_at FROM course_question_batches WHERE course_id = ? ORDER BY created_at DESC'
  ).bind(courseId).all();

  return createResponse(JSON.stringify({ course, materials, questions, batches }));
}

async function handleDeleteCourse(request, env, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  await env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ success: true }));
}

async function handleUploadCourseMaterial(request, env, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const form = await request.formData();
  const file = form.get('file');
  const text = form.get('text');
  const name = (form.get('name') || (file ? file.name : 'text-material')).toString();

  let contentText = '';
  let size = 0;
  let type = 'text/plain';
  let uploadBody = null;

  if (file && file.size > 0) {
    size = file.size;
    type = file.type || 'application/octet-stream';
    uploadBody = file;

    if (type.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
      try {
        contentText = await file.text();
      } catch (e) {
        contentText = '';
      }
    }
  } else if (text) {
    contentText = text.toString();
    size = contentText.length;
    type = 'text/plain';
    uploadBody = new Blob([contentText], { type: 'text/plain' });
  } else {
    return createResponse(JSON.stringify({ error: 'No file or text provided' }), 400);
  }

  // 先插入元数据记录，获取 material id
  const insertResult = await env.DB.prepare(
    'INSERT INTO course_materials (course_id, name, size, type, content_text, r2_key) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(courseId, name, size, type, contentText, '').run();

  const materialId = insertResult.meta.last_row_id;

  // 上传原始文件到 R2
  let r2Key = '';
  try {
    r2Key = buildMaterialR2Key(courseId, materialId, name);
    await uploadToR2(uploadBody, r2Key, env);
  } catch (r2Err) {
    console.error('[R2] upload failed:', r2Err);
    // 上传失败时回滚数据库记录
    await env.DB.prepare('DELETE FROM course_materials WHERE id = ?').bind(materialId).run();
    return createResponse(JSON.stringify({ error: 'Failed to upload file to storage' }), 500);
  }

  // 更新 R2 key
  await env.DB.prepare('UPDATE course_materials SET r2_key = ? WHERE id = ?').bind(r2Key, materialId).run();

  const material = await env.DB.prepare('SELECT id, course_id, name, size, type, content_text, r2_key, created_at FROM course_materials WHERE id = ?')
    .bind(materialId).first();

  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ material }));
}

async function handleDeleteCourseMaterial(request, env, courseId, materialId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const material = await env.DB.prepare('SELECT r2_key FROM course_materials WHERE id = ? AND course_id = ?')
    .bind(materialId, courseId).first();

  if (material && material.r2_key) {
    try {
      await env.MATERIALS_BUCKET.delete(material.r2_key);
    } catch (e) {
      console.error('[R2] delete failed:', material.r2_key, e);
    }
  }

  await env.DB.prepare('DELETE FROM course_materials WHERE id = ? AND course_id = ?')
    .bind(materialId, courseId).run();

  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ success: true }));
}

async function handleDownloadCourseMaterial(request, env, courseId, materialId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();
  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const material = await env.DB.prepare(
    'SELECT id, name, size, type, content_text, r2_key FROM course_materials WHERE id = ? AND course_id = ?'
  ).bind(materialId, courseId).first();
  if (!material) return createResponse(JSON.stringify({ error: 'Material not found' }), 404);

  // Prefer R2 object if available
  if (material.r2_key) {
    const object = await readR2Object(material.r2_key, env);
    if (object && object.body) {
      const headers = new Headers();
      const contentType = object.httpMetadata?.contentType || material.type || 'application/octet-stream';
      headers.set('Content-Type', contentType);
      headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(material.name)}"`);
      const cors = getCorsHeaders(request);
      for (const [key, value] of Object.entries(cors)) {
        headers.set(key, value);
      }
      return new Response(object.body, { headers });
    }
  }

  // Fallback to inline content_text
  if (material.content_text) {
    const headers = new Headers();
    headers.set('Content-Type', 'text/plain;charset=utf-8');
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(material.name)}"`);
    const cors = getCorsHeaders(request);
    for (const [key, value] of Object.entries(cors)) {
      headers.set(key, value);
    }
    return new Response(material.content_text, { headers });
  }

  return createResponse(JSON.stringify({ error: 'File not available' }), 404);
}

async function generateQuestionsWithDeepSeekFromText(text, options, env, onEvent) {
  const { questionCount, lang, fileName } = options;
  const totalBatches = Math.ceil(questionCount / 20);
  const chunks = splitTextByPageMarkers(text, totalBatches);
  console.log(`[DeepSeek Course] split into ${chunks.length} chunks for ${totalBatches} batches, text length ${text.length}`);

  const allResults = [];
  let failedBatches = 0;

  for (let i = 0; i < totalBatches; i++) {
    const startId = i * 20 + 1;
    const chunkText = chunks[i] || '';
    const batchQuestionCount = Math.min(20, questionCount - i * 20);
    const prompt = buildFallbackBatchPrompt(chunkText, i, totalBatches, lang, startId, fileName || 'course', '', batchQuestionCount);

    onEvent({ type: 'batch_start', batchIndex: i, totalBatches });

    try {
      const result = await callDeepSeekWithRetry([
        { role: 'system', content: 'You are an expert exam question creator. Always respond with valid JSON format.' },
        { role: 'user', content: `Study Material:\n${chunkText}\n\n${prompt}` }
      ], env.DEEPSEEK_API_KEY, 2);

      const content = result.choices?.[0]?.message?.content || '';
      const questions = extractJSONFromText(content);

      if (Array.isArray(questions)) {
        allResults.push(...questions);
        onEvent({ type: 'batch_done', batchIndex: i, count: questions.length });
      } else {
        throw new Error(`Batch ${i} returned non-array result`);
      }
    } catch (err) {
      console.error(`[DeepSeek Course] Batch ${i} failed:`, err);
      failedBatches++;
      onEvent({ type: 'batch_error', batchIndex: i, message: err.message });
    }
  }

  allResults.forEach((q, idx) => { q.id = idx + 1; });
  const generatedCount = allResults.length;
  const requestedCount = questionCount;
  const partial = failedBatches > 0 || generatedCount < Math.ceil(requestedCount * 0.95);

  console.log(`[DeepSeek Course] final result: ${generatedCount}/${requestedCount}, partial=${partial}`);

  onEvent({ type: 'final_result', data: allResults, generatedCount, requestedCount, partial });
  onEvent({ type: 'done' });

  return { questions: allResults, partialSuccess: partial, generatedCount, requestedCount };
}

async function handleAnalyzeCourse(request, env, ctx, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id, name FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();
  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    body = {};
  }
  const turnstileToken = body?.turnstileToken;

  // Turnstile verification
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
    }
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
      }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
    }
  }

  const { results: materials } = await env.DB.prepare(
    'SELECT id, name, type, content_text, r2_key FROM course_materials WHERE course_id = ? AND analyzed_at IS NULL ORDER BY created_at DESC'
  ).bind(courseId).all();

  // PDF 资料走 Vertex（R2 → GCS → Gemini），文本资料走 DeepSeek
  const pdfMaterials = materials.filter(m => m.r2_key && isPdfType(m.type, m.name));

  let combinedText = '';
  const textMaterialIds = [];
  const textMaterialNames = [];
  for (const m of materials) {
    if (isPdfType(m.type, m.name)) continue;
    let text = '';
    if (m.content_text && m.content_text.trim().length > 0) {
      text = m.content_text.trim();
    } else if (m.r2_key && isTextType(m.type, m.name)) {
      text = (await readR2Text(m.r2_key, env)).trim();
    }
    if (text) {
      combinedText += `\n\n--- 资料：${m.name} ---\n\n${text}`;
      textMaterialIds.push(m.id);
      textMaterialNames.push(m.name);
    }
  }

  if (combinedText.trim().length === 0 && pdfMaterials.length === 0) {
    return createResponse(JSON.stringify({ error: 'No new materials to analyze' }), 400);
  }
  if (combinedText.length > 500000) {
    return createResponse(JSON.stringify({ error: 'Combined text too long (max 500KB)' }), 400);
  }

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendSSE = async (obj) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };

  const questionCount = Math.min(Math.max(parseInt(body?.questionCount) || 20, 1), 200);
  const lang = ['zh', 'zh-TW', 'en', 'ko'].includes(body?.lang) ? body.lang : 'zh';
  const hasText = combinedText.trim().length > 0;
  const hasPdfs = pdfMaterials.length > 0;

  if (hasText && !env.DEEPSEEK_API_KEY) {
    return createResponse(JSON.stringify({ error: 'DeepSeek API key not configured' }), 500);
  }
  if (hasPdfs && !(env.GCP_PRIVATE_KEY && env.GCP_CLIENT_EMAIL && env.GCP_PROJECT_ID && env.GCS_BUCKET)) {
    return createResponse(JSON.stringify({ error: 'PDF processing not configured (GCP credentials missing)' }), 500);
  }

  ctx.waitUntil((async () => {
    try {
      const allResults = [];
      const processedPdfIds = [];

      // 1) PDF 资料：R2 → GCS → Vertex Gemini（复用 /pdf_generate 的现成路径）
      if (hasPdfs) {
        const token = await getAccessToken(env);
        for (let i = 0; i < pdfMaterials.length; i++) {
          const m = pdfMaterials[i];
          await sendSSE({ type: 'batch_start', batchIndex: i, totalBatches: pdfMaterials.length });
          const obj = await readR2Object(m.r2_key, env);
          if (!obj) {
            await sendSSE({ type: 'batch_error', batchIndex: i, message: `Material not found in storage: ${m.name}` });
            continue;
          }
          const gcsName = `analyze_${Date.now()}_${sanitizeForR2Key(m.name || 'document.pdf')}`;
          try {
            const buffer = await obj.arrayBuffer();
            const fileUri = await uploadToGCS(buffer, gcsName, token, env);
            // pageCount 传 20：单批次出 20 题，对应提示词的 pages 1-20
            const prompt = buildBatchPrompt(0, 1, lang, m.name || 'document', 20);
            const vertexRes = await streamVertex(fileUri, prompt, env, token);
            if (!vertexRes.ok) {
              throw new Error(`Vertex failed: ${await vertexRes.text()}`);
            }
            const result = await parseBatchResponse(vertexRes);
            allResults.push(...result.questions);
            processedPdfIds.push(m.id);
            await sendSSE({ type: 'batch_done', batchIndex: i, count: result.questions.length });
          } catch (pdfErr) {
            console.error(`[Analyze] PDF material ${m.id} failed:`, pdfErr);
            await sendSSE({ type: 'batch_error', batchIndex: i, message: pdfErr.message });
          } finally {
            try { await deleteFromGCS(gcsName, token, env); } catch (e) { console.error('[Analyze] GCS cleanup failed:', e); }
          }
        }
      }

      // 2) 文本资料：DeepSeek（PDF 已发过 final_result/done 时，过滤掉重复事件）
      if (hasText) {
        const deepseekOnEvent = hasPdfs
          ? (ev) => (ev.type === 'final_result' || ev.type === 'done') ? Promise.resolve() : sendSSE(ev)
          : sendSSE;
        const { questions } = await generateQuestionsWithDeepSeekFromText(
          combinedText,
          { questionCount, lang, fileName: course.name || 'course' },
          env,
          deepseekOnEvent
        );
        allResults.push(...questions);
      }

      if (hasPdfs) {
        allResults.forEach((q, idx) => { q.id = idx + 1; });
        await sendSSE({ type: 'final_result', data: allResults, generatedCount: allResults.length, requestedCount: questionCount, partial: false });
        await sendSSE({ type: 'done' });
      }

      if (allResults.length === 0) {
        throw new Error('No questions generated from course materials');
      }

      try {
        // 创建题目批次（窗口），默认名称为本次资料名（多个用顿号连接）
        const batchName = [...pdfMaterials.map(m => m.name), ...textMaterialNames].filter(Boolean).join('、') || '未命名批次';
        const batchResult = await env.DB.prepare(
          'INSERT INTO course_question_batches (course_id, name) VALUES (?, ?)'
        ).bind(courseId, batchName.slice(0, 200)).run();
        const batchId = batchResult.meta.last_row_id;

        await saveGeneratedQuestionsToCourse(env, courseId, allResults, null, batchId);

        // 标记本次成功处理的资料为已解析，避免下次重复生成
        const analyzedIds = hasText ? [...processedPdfIds, ...textMaterialIds] : processedPdfIds;
        if (analyzedIds.length > 0) {
          const placeholders = analyzedIds.map(() => '?').join(',');
          await env.DB.prepare(
            `UPDATE course_materials SET analyzed_at = datetime('now') WHERE id IN (${placeholders})`
          ).bind(...analyzedIds).run();
        }

        await sendSSE({ type: 'saved', count: allResults.length });
      } catch (saveErr) {
        console.error('[Analyze] Failed to save generated questions:', saveErr);
        await sendSSE({ type: 'error', message: 'Failed to save generated questions' });
      }
    } catch (err) {
      console.error('[Analyze] error:', err);
      await sendSSE({ type: 'error', message: err.message });
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...getCorsHeaders(request),
    },
  });
}
async function handleSaveCourseQuestions(request, env, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const body = await request.json();
  const questions = body.questions;

  if (!Array.isArray(questions) || questions.length === 0) {
    return createResponse(JSON.stringify({ error: 'Questions array is required' }), 400);
  }

  const stmt = env.DB.prepare(
    'INSERT INTO course_questions (course_id, type, title, content, answer, explanation, difficulty, tags, source_material_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const batch = questions.map(q => stmt.bind(
    courseId,
    q.type || 'choice',
    q.title || '',
    typeof q.content === 'string' ? q.content : JSON.stringify(q.content),
    q.answer || '',
    q.explanation || '',
    q.difficulty || 1,
    JSON.stringify(q.tags || []),
    q.source_material_id || null
  ));

  await env.DB.batch(batch);
  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ success: true, count: questions.length }));
}

// 核心：从文本生成题目，复用于 /text_generate 和 /api/courses/:id/analyze
async function generateQuestionsFromText(text, options, env, onEvent) {
  const { questionCount, lang, fileName, fileType } = options;

  const totalBatches = Math.ceil(questionCount / 20);
  const chunks = splitTextIntoChunks(text, totalBatches, fileType, fileName);
  console.log(`[DEBUG] generateQuestionsFromText: split into ${chunks.length} chunks for ${totalBatches} batches`);

  const token = await getAccessToken(env);
  const allResults = [];
  let totalTokenCount = 0;

  // batch0 流式返回
  const batch0Prompt = buildTextBatchPrompt(0, totalBatches, lang, fileName, chunks[0] || '');
  const vertexRes0 = await streamVertexFromText(chunks[0] || '', batch0Prompt, env, token);

  if (!vertexRes0.ok) {
    const errText = await vertexRes0.text();
    throw new Error(`VERTEX_ERROR|Batch 0 failed: ${errText}`);
  }

  const batch0Result = await streamBatchToClient(vertexRes0, onEvent, 'batch0');
  allResults.push(...batch0Result.questions);
  totalTokenCount += batch0Result.totalTokenCount || 0;
  onEvent({ type: 'batch0_done', count: batch0Result.questions.length });

  // 并行执行其他批次
  if (totalBatches > 1) {
    const otherBatchPromises = [];
    for (let i = 1; i < totalBatches; i++) {
      const prompt = buildTextBatchPrompt(i, totalBatches, lang, fileName, chunks[i] || '');
      otherBatchPromises.push(
        streamVertexFromText(chunks[i] || '', prompt, env, token)
          .then(res => parseBatchResponse(res))
          .catch(err => {
            console.error(`[DEBUG] Batch ${i} failed:`, err);
            return { questions: [], totalTokenCount: 0 };
          })
      );
    }

    const otherResults = await Promise.all(otherBatchPromises);
    otherResults.forEach(result => {
      allResults.push(...result.questions);
      totalTokenCount += result.totalTokenCount || 0;
    });
  }

  // 重新编号
  allResults.forEach((q, idx) => { q.id = idx + 1; });
  console.log(`[DEBUG] Final result: ${allResults.length} questions`);
  if (allResults.length > 0) {
    console.log(`[DEBUG] First question:`, allResults[0].question?.substring(0, 50));
  }
  console.log(`[DEBUG] Total token count: ${totalTokenCount}`);

  onEvent({ type: 'final_result', data: allResults, tokenCount: totalTokenCount });
  onEvent({ type: 'done' });

  return { questions: allResults, totalTokenCount };
}

async function handleDeleteCourseQuestion(request, env, courseId, questionId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();

  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  await env.DB.prepare('DELETE FROM course_questions WHERE id = ? AND course_id = ?')
    .bind(questionId, courseId).run();

  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ success: true }));
}

// 重命名题目批次（窗口）
async function handleRenameCourseBatch(request, env, courseId, batchId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();
  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  const body = await request.json().catch(() => ({}));
  const name = (body.name || '').toString().trim();
  if (!name) return createResponse(JSON.stringify({ error: 'Name is required' }), 400);
  if (name.length > 200) return createResponse(JSON.stringify({ error: 'Name too long (max 200 chars)' }), 400);

  const result = await env.DB.prepare(
    'UPDATE course_question_batches SET name = ? WHERE id = ? AND course_id = ?'
  ).bind(name, batchId, courseId).run();

  if (!result.meta.changes) return createResponse(JSON.stringify({ error: 'Batch not found' }), 404);

  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();

  return createResponse(JSON.stringify({ success: true }));
}

// Helper: persist AI-generated questions to a course
async function saveGeneratedQuestionsToCourse(env, courseId, questions, sourceMaterialId = null, batchId = null) {
  if (!Array.isArray(questions) || questions.length === 0) return;

  const stmt = env.DB.prepare(
    'INSERT INTO course_questions (course_id, type, title, content, answer, explanation, difficulty, tags, source_material_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const batch = questions.map(q => {
    const contentObj = {
      question: q.question || '',
      options: q.options || {}
    };
    return stmt.bind(
      courseId,
      'choice',
      (q.question || '').slice(0, 80),
      JSON.stringify(contentObj),
      q.correctAnswer || q.answer || '',
      q.explanation || '',
      q.difficulty || 1,
      JSON.stringify([]),
      sourceMaterialId,
      batchId
    );
  });

  await env.DB.batch(batch);
  await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(courseId).run();
}

// 为单个课程资料生成题库（PDF/文本均支持），结果与 /pdf_generate 格式一致
async function generateQuestionsForMaterial(material, options, env, onEvent) {
  const { questionCount, lang } = options;
  const isPdf = isPdfType(material.type, material.name);
  const isText = isTextType(material.type, material.name);
  const fileName = material.name || 'document';

  const hasContentText = material.content_text && material.content_text.trim().length > 0;
  const hasR2Text = isText && material.r2_key;
  if (!isPdf && !hasContentText && !hasR2Text) {
    throw new Error('Unsupported material type');
  }

  if (isPdf) {
    // PDF：R2 → GCS → Vertex Gemini
    if (!(env.GCP_PRIVATE_KEY && env.GCP_CLIENT_EMAIL && env.GCP_PROJECT_ID && env.GCS_BUCKET)) {
      throw new Error('PDF processing not configured');
    }

    const obj = await readR2Object(material.r2_key, env);
    if (!obj) {
      throw new Error(`Material not found in storage: ${fileName}`);
    }

    const token = await getAccessToken(env);
    const gcsName = `course_${material.course_id}_${Date.now()}_${sanitizeForR2Key(fileName)}`;
    let fileUri = null;

    try {
      const buffer = await obj.arrayBuffer();
      fileUri = await uploadToGCS(buffer, gcsName, token, env);

      const totalBatches = Math.ceil(questionCount / 20);
      const allResults = [];
      let totalTokenCount = 0;

      // batch0 流式返回
      const batch0Prompt = buildBatchPrompt(0, totalBatches, lang, fileName, 0, '');
      const vertexRes0 = await streamVertex(fileUri, batch0Prompt, env, token);
      if (!vertexRes0.ok) {
        throw new Error(`VERTEX_ERROR|Batch 0 failed: ${await vertexRes0.text()}`);
      }
      const batch0Result = await streamBatchToClient(vertexRes0, onEvent, 'batch0');
      allResults.push(...batch0Result.questions);
      totalTokenCount += batch0Result.totalTokenCount || 0;
      onEvent({ type: 'batch0_done', count: batch0Result.questions.length });

      // 并行执行其他批次
      if (totalBatches > 1) {
        const otherBatchPromises = [];
        for (let i = 1; i < totalBatches; i++) {
          const prompt = buildBatchPrompt(i, totalBatches, lang, fileName, 0, '');
          otherBatchPromises.push(
            streamVertex(fileUri, prompt, env, token)
              .then(res => parseBatchResponse(res))
              .catch(err => {
                console.error(`[GenerateBank] Batch ${i} failed:`, err);
                return { questions: [], totalTokenCount: 0 };
              })
          );
        }
        const otherResults = await Promise.all(otherBatchPromises);
        otherResults.forEach(result => {
          allResults.push(...result.questions);
          totalTokenCount += result.totalTokenCount || 0;
        });
      }

      allResults.forEach((q, idx) => { q.id = idx + 1; });
      const generatedCount = allResults.length;
      const threshold = Math.ceil(questionCount * 0.95);
      const partial = generatedCount < threshold;

      onEvent({ type: 'final_result', data: allResults, tokenCount: totalTokenCount, generatedCount, requestedCount: questionCount, partial });
      onEvent({ type: 'done' });

      return { questions: allResults, totalTokenCount, partial };
    } finally {
      try { if (fileUri) await deleteFromGCS(gcsName, token, env); } catch (e) { console.error('[GenerateBank] GCS cleanup failed:', e); }
    }
  } else {
    // 文本：走 Vertex Gemini（复用 /text_generate 路径）
    if (!env.GCP_PRIVATE_KEY) {
      throw new Error('Text generation not configured');
    }

    let text = '';
    if (material.content_text && material.content_text.trim().length > 0) {
      text = material.content_text.trim();
    } else if (material.r2_key) {
      text = (await readR2Text(material.r2_key, env)).trim();
    }

    if (!text) {
      throw new Error(`No text content available: ${fileName}`);
    }

    return await generateQuestionsFromText(
      text,
      { questionCount, lang, fileName, fileType: material.type || 'txt' },
      env,
      onEvent
    );
  }
}

// 批量为课程资料生成题库（每个文件一个题库），内部限并发
async function handleGenerateCourseBanks(request, env, ctx, courseId) {
  const user = await getUserFromRequest(request, env);
  if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);

  const course = await env.DB.prepare(
    'SELECT id, name FROM courses WHERE id = ? AND user_id = ?'
  ).bind(courseId, user.id).first();
  if (!course) return createResponse(JSON.stringify({ error: 'Course not found' }), 404);

  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }

  const materialIds = body?.materialIds;
  if (!Array.isArray(materialIds) || materialIds.length === 0) {
    return createResponse(JSON.stringify({ error: 'materialIds array is required' }), 400);
  }
  if (materialIds.length > 10) {
    return createResponse(JSON.stringify({ error: 'Too many materials (max 10 per request)' }), 400);
  }

  const questionCount = Math.min(Math.max(parseInt(body?.questionCount) || 20, 1), 200);
  const lang = ['zh', 'zh-TW', 'en', 'ko'].includes(body?.lang) ? body.lang : 'zh';
  const turnstileToken = body?.turnstileToken;

  // Turnstile verification
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
    }
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: turnstileToken,
      }),
    });
    const verifyData = await verifyRes.json();
    if (!verifyData.success) {
      return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
    }
  }

  // 校验额度：每个文件扣 1 点
  const quota = await peekUserQuota(user.id, env, materialIds.length);
  if (!quota.allowed) {
    return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient quota' }), 402);
  }

  // 查询资料并校验归属
  const placeholders = materialIds.map(() => '?').join(',');
  const { results: materials } = await env.DB.prepare(
    `SELECT id, course_id, name, type, content_text, r2_key FROM course_materials WHERE course_id = ? AND id IN (${placeholders})`
  ).bind(courseId, ...materialIds).all();

  if (materials.length === 0) {
    return createResponse(JSON.stringify({ error: 'No materials found' }), 404);
  }

  // 保持请求顺序
  const materialMap = new Map(materials.map(m => [m.id, m]));
  const orderedMaterials = materialIds.map(id => materialMap.get(id)).filter(Boolean);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const sendSSE = async (obj) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  };

  ctx.waitUntil((async () => {
    try {
      const CONCURRENCY = 2;
      const queue = orderedMaterials.map((m, index) => ({ ...m, index }));
      const running = new Set();
      let completedCount = 0;
      let failedCount = 0;

      async function runOne(item) {
        const onFileEvent = async (ev) => {
          await sendSSE({ ...ev, fileId: item.id, fileName: item.name, fileIndex: item.index });
        };

        try {
          await sendSSE({ type: 'file_start', fileId: item.id, fileName: item.name, fileIndex: item.index });
          const result = await generateQuestionsForMaterial(
            item,
            { questionCount, lang },
            env,
            onFileEvent
          );
          completedCount++;
          await sendSSE({
            type: 'file_done',
            fileId: item.id,
            fileName: item.name,
            fileIndex: item.index,
            questions: result.questions,
            generatedCount: result.questions.length,
            requestedCount: questionCount,
            partial: result.partial
          });
        } catch (err) {
          failedCount++;
          console.error(`[GenerateCourseBanks] Material ${item.id} failed:`, err);
          await sendSSE({
            type: 'file_error',
            fileId: item.id,
            fileName: item.name,
            fileIndex: item.index,
            message: err.message
          });
        }
      }

      while (queue.length > 0 || running.size > 0) {
        while (running.size < CONCURRENCY && queue.length > 0) {
          const item = queue.shift();
          const p = runOne(item).finally(() => running.delete(p));
          running.add(p);
        }
        if (running.size > 0) {
          await Promise.race(running);
        }
      }

      // 扣费：只有成功生成的文件才扣
      const cost = completedCount;
      if (cost > 0) {
        for (let i = 0; i < cost; i++) {
          await deductUserQuota(user.id, env, 'Generate course bank', 1);
        }
      }

      await sendSSE({
        type: 'all_done',
        completedCount,
        failedCount,
        totalCount: orderedMaterials.length
      });
    } catch (err) {
      console.error('[GenerateCourseBanks] error:', err);
      await sendSSE({ type: 'error', message: err.message });
    } finally {
      await writer.close();
    }
  })());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...getCorsHeaders(request),
    },
  });
}

/* ==================== CLOUD BANK ROUTES ==================== */

// 上传本地题库到云端
async function handleUploadCloudBank(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const body = await request.json();
  const { title, content, is_public, password } = body;
  const sourceR2Key = body?.source_r2_key || body?.sourceR2Key || null;
  const sourceName = body?.source_name || body?.sourceName || null;
  const sourceType = body?.source_type || body?.sourceType || null;
  const sourceSize = parseInt(body?.source_size || body?.sourceSize) || 0;
  const courseId = parseInt(body?.course_id || body?.courseId) || null;

  if (!title || !content) {
    return createResponse(JSON.stringify({ error: 'Title and content are required' }), 400);
  }

  // 校验课程归属（防止把题库挂到别人的课程下）
  if (courseId) {
    const ownedCourse = await env.DB.prepare(
      'SELECT id FROM courses WHERE id = ? AND user_id = ?'
    ).bind(courseId, user.id).first();
    if (!ownedCourse) {
      return createResponse(JSON.stringify({ error: 'Course not found' }), 400);
    }
  }
  
  let passwordHash = null;
  let passwordSalt = null;
  
  if (password && password.length > 0) {
    const hashed = await hashPassword(password);
    passwordHash = JSON.stringify(hashed.hash);
    passwordSalt = JSON.stringify(hashed.salt);
  }
  
  // 从 content 中解析题目数量
  let questionsCount = 0;
  try {
    const bankData = JSON.parse(content);
    questionsCount = bankData.questions?.length || 0;
  } catch (e) {
    return createResponse(JSON.stringify({ error: 'Invalid content JSON' }), 400);
  }
  
  const result = await env.DB.prepare(
    'INSERT INTO question_banks (user_id, title, content, is_public, password_hash, password_salt, questions_count, source_r2_key, source_name, source_type, source_size, course_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(user.id, title, content, is_public ? 1 : 0, passwordHash, passwordSalt, questionsCount, sourceR2Key, sourceName, sourceType, sourceSize, courseId).run();

  const bank = await env.DB.prepare('SELECT * FROM question_banks WHERE id = ?')
    .bind(result.meta.last_row_id)
    .first();

  return createResponse(JSON.stringify({
    bank: {
      id: bank.id,
      title: bank.title,
      is_public: bank.is_public,
      has_password: !!bank.password_hash,
      questions_count: bank.questions_count,
      source_r2_key: bank.source_r2_key,
      source_name: bank.source_name,
      source_type: bank.source_type,
      source_size: bank.source_size,
      course_id: bank.course_id,
      created_at: bank.created_at
    }
  }));
}

// 获取当前用户的云端题库列表
async function handleGetCloudBanks(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const { results } = await env.DB.prepare(
    'SELECT id, title, questions_count, is_public, password_hash, download_count, source_r2_key, source_name, source_type, source_size, course_id, created_at FROM question_banks WHERE user_id = ? ORDER BY updated_at DESC'
  ).bind(user.id).all();

  const banks = results.map(b => ({
    id: b.id,
    title: b.title,
    questions_count: b.questions_count,
    is_public: b.is_public,
    has_password: !!b.password_hash,
    download_count: b.download_count,
    has_source_file: !!b.source_r2_key,
    source_name: b.source_name,
    source_type: b.source_type,
    source_size: b.source_size,
    course_id: b.course_id,
    created_at: b.created_at
  }));

  return createResponse(JSON.stringify({ banks }));
}

// 更新云端题库元信息（仅 owner）：回填源文件 source_*，或把无课程题库归入某课程
async function handleUpdateCloudBankSource(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }

  const body = await request.json().catch(() => ({}));
  const sourceR2Key = body?.source_r2_key || body?.sourceR2Key || null;
  const sourceName = body?.source_name || body?.sourceName || null;
  const sourceType = body?.source_type || body?.sourceType || null;
  const sourceSize = body?.source_size != null || body?.sourceSize != null
    ? (parseInt(body?.source_size || body?.sourceSize) || 0)
    : null;
  const courseId = parseInt(body?.course_id || body?.courseId) || null;

  if (!sourceR2Key && !courseId) {
    return createResponse(JSON.stringify({ error: 'Nothing to update' }), 400);
  }

  // 校验课程归属（防止把题库挂到别人的课程下）
  if (courseId) {
    const ownedCourse = await env.DB.prepare(
      'SELECT id FROM courses WHERE id = ? AND user_id = ?'
    ).bind(courseId, user.id).first();
    if (!ownedCourse) {
      return createResponse(JSON.stringify({ error: 'Course not found' }), 400);
    }
  }

  const result = await env.DB.prepare(
    `UPDATE question_banks SET
       source_r2_key = COALESCE(?, source_r2_key),
       source_name = COALESCE(?, source_name),
       source_type = COALESCE(?, source_type),
       source_size = COALESCE(?, source_size),
       course_id = COALESCE(?, course_id)
     WHERE id = ? AND user_id = ?`
  ).bind(sourceR2Key, sourceName, sourceType, sourceSize, courseId, bankId, user.id).run();

  if (!result.meta.changes) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }

  return createResponse(JSON.stringify({ success: true }));
}

// 下载云端题库的源文件（仅 owner）
async function handleDownloadCloudBankSourceFile(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ? AND user_id = ?'
  ).bind(bankId, user.id).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  if (!bank.source_r2_key) {
    return createResponse(JSON.stringify({ error: 'No source file for this bank' }), 404);
  }
  
  const object = await readR2Object(bank.source_r2_key, env);
  if (!object) {
    return createResponse(JSON.stringify({ error: 'Source file not found in storage' }), 404);
  }
  
  const headers = new Headers();
  const contentType = object.httpMetadata?.contentType || bank.source_type || 'application/octet-stream';
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(bank.source_name || 'source')}"`);
  
  return new Response(object.body, {
    status: 200,
    headers: { ...getCorsHeaders(request), ...Object.fromEntries(headers) }
  });
}

// 删除云端题库
async function handleDeleteCloudBank(request, env, bankId) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ? AND user_id = ?'
  ).bind(bankId, user.id).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  await env.DB.prepare('DELETE FROM question_banks WHERE id = ?').bind(bankId).run();
  
  return createResponse(JSON.stringify({ success: true }));
}



/* ==================== SHARE ROUTES ==================== */

// 内存级密码错误限流（每个 Worker 实例独立）
const sharePasswordAttempts = new Map();

function checkShareRateLimit(shareId) {
  const now = Date.now();
  const key = String(shareId);
  const record = sharePasswordAttempts.get(key);
  
  if (record) {
    // 清理 5 分钟前的记录
    if (now - record.firstAttempt > 5 * 60 * 1000) {
      sharePasswordAttempts.delete(key);
      return { allowed: true };
    }
    if (record.count >= 5) {
      return { allowed: false, retryAfter: Math.ceil((5 * 60 * 1000 - (now - record.firstAttempt)) / 1000) };
    }
  }
  
  return { allowed: true };
}

function recordShareAttempt(shareId) {
  const key = String(shareId);
  const record = sharePasswordAttempts.get(key);
  if (record) {
    record.count++;
  } else {
    sharePasswordAttempts.set(key, { count: 1, firstAttempt: Date.now() });
  }
}

// 获取公开题库 metadata
async function handleGetShareBank(request, env, bankId) {
  const bank = await env.DB.prepare(
    'SELECT id, title, questions_count, is_public, password_hash, download_count, created_at FROM question_banks WHERE id = ?'
  ).bind(bankId).first();
  
  if (!bank || !bank.is_public) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  return createResponse(JSON.stringify({
    id: bank.id,
    title: bank.title,
    questions_count: bank.questions_count,
    has_password: !!bank.password_hash,
    download_count: bank.download_count,
    created_at: bank.created_at
  }));
}

// 验证密码并下载题库内容（owner 可直接下载，无需密码）
async function handleDownloadShareBank(request, env, bankId) {
  const bank = await env.DB.prepare(
    'SELECT * FROM question_banks WHERE id = ?'
  ).bind(bankId).first();
  
  if (!bank) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  // 检查是否是 owner
  const user = await getUserFromRequest(request, env);
  const isOwner = user && user.id === bank.user_id;
  
  // 非 owner 且私有题库 → 404
  if (!isOwner && !bank.is_public) {
    return createResponse(JSON.stringify({ error: 'Bank not found' }), 404);
  }
  
  let providedPassword = '';
  try {
    const body = await request.json();
    providedPassword = body.password || '';
  } catch (e) {
    providedPassword = '';
  }
  
  // 如有密码且不是 owner，验证密码
  if (!isOwner && bank.password_hash && bank.password_salt) {
    // 检查限流
    const rl = checkShareRateLimit(bankId);
    if (!rl.allowed) {
      return createResponse(JSON.stringify({ error: 'Too many attempts, please try again later' }), 429);
    }
    
    let storedHash, storedSalt;
    try {
      storedHash = JSON.parse(bank.password_hash);
      storedSalt = JSON.parse(bank.password_salt);
    } catch (e) {
      return createResponse(JSON.stringify({ error: 'Server error' }), 500);
    }
    
    const valid = await verifyPassword(providedPassword, storedHash, storedSalt);
    if (!valid) {
      recordShareAttempt(bankId);
      return createResponse(JSON.stringify({ error: 'Incorrect password' }), 403);
    }
  }
  
  // owner 或验证通过
  await env.DB.prepare(
    'UPDATE question_banks SET download_count = download_count + 1 WHERE id = ?'
  ).bind(bankId).run();
  
  return createResponse(JSON.stringify({
    content: bank.content,
    title: bank.title
  }));
}

/* ==================== BALANCE & QUOTA ==================== */

async function checkAndConsumeQuota(userId, env) {
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(userId)
    .first();
  
  if (!balance) return { allowed: false, reason: 'Balance record not found' };
  
  // 检查是否需要重置每日免费额度
  const today = new Date().toISOString().split('T')[0];
  if (balance.last_reset_date !== today) {
    await env.DB.prepare(
      'UPDATE balances SET free_quota_used = 0, last_reset_date = ? WHERE user_id = ?'
    ).bind(today, userId).run();
    balance.free_quota_used = 0;
  }
  
  // 优先使用免费额度
  if (balance.free_quota_used < balance.free_quota_daily) {
    await env.DB.prepare(
      'UPDATE balances SET free_quota_used = free_quota_used + 1 WHERE user_id = ?'
    ).bind(userId).run();
    return { allowed: true, type: 'free' };
  }
  
  // 检查余额（点数制，每次消耗1点=1分钱）
  if (balance.amount >= 1) {
    await env.DB.prepare(
      'UPDATE balances SET amount = amount - 1 WHERE user_id = ?'
    ).bind(userId).run();
    
    // 记录交易
    await env.DB.prepare(
      'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
    ).bind(userId, 'consume', -1, 'Generate questions').run();
    
    return { allowed: true, type: 'paid' };
  }
  
  return { allowed: false, reason: 'Quota exceeded and insufficient balance' };
}

// 仅检查用户额度，不扣除（用于 pdf_generate 延迟扣费）
async function peekUserQuota(userId, env, cost = 1) {
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(userId)
    .first();
  
  if (!balance) return { allowed: false, reason: 'Balance record not found' };
  
  // 检查是否需要重置每日免费额度
  const today = new Date().toISOString().split('T')[0];
  if (balance.last_reset_date !== today) {
    balance.free_quota_used = 0;
  }
  
  const totalQuota = (balance.free_quota_daily - balance.free_quota_used) + balance.amount;
  if (totalQuota < cost) return { allowed: false, reason: 'Quota exceeded and insufficient balance' };
  
  return { allowed: true };
}

// 扣除用户额度（带并发保护）
async function deductUserQuota(userId, env, action = 'Generate questions', cost = 1) {
  const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(userId)
    .first();
  
  if (!balance) return false;
  
  // 检查是否需要重置每日免费额度
  const today = new Date().toISOString().split('T')[0];
  if (balance.last_reset_date !== today) {
    balance.free_quota_used = 0;
  }
  
  // 循环扣费（每次 1 点，优先免费额度）
  for (let i = 0; i < cost; i++) {
    // 优先尝试免费额度（条件更新防并发）
    const freeResult = await env.DB.prepare(
      'UPDATE balances SET free_quota_used = free_quota_used + 1, last_reset_date = ? WHERE user_id = ? AND free_quota_used < free_quota_daily'
    ).bind(today, userId).run();
    if (freeResult.meta?.changes > 0) continue;
    
    // 再尝试付费余额（条件更新防并发）
    const paidResult = await env.DB.prepare(
      'UPDATE balances SET amount = amount - 1 WHERE user_id = ? AND amount >= 1'
    ).bind(userId).run();
    if (paidResult.meta?.changes > 0) {
      await env.DB.prepare(
        'INSERT INTO transactions (user_id, type, amount, description) VALUES (?, ?, ?, ?)'
      ).bind(userId, 'consume', -1, action).run();
      continue;
    }
    
    // 某一次扣费失败，已扣的无法回滚
    return false;
  }
  
  return true;
}

async function handleGetBalance(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }
  
  let balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
    .bind(user.id)
    .first();
  
  // 检查是否需要重置免费额度
  const today = new Date().toISOString().split('T')[0];
  if (balance && balance.last_reset_date !== today) {
    await env.DB.prepare(
      'UPDATE balances SET free_quota_used = 0, last_reset_date = ? WHERE user_id = ?'
    ).bind(today, user.id).run();
    balance.free_quota_used = 0;
    balance.last_reset_date = today;
  }
  
  return createResponse(JSON.stringify({
    balance: balance?.amount || 0,
    freeQuotaDaily: balance?.free_quota_daily || 10,
    freeQuotaUsed: balance?.free_quota_used || 0,
    freeQuotaLeft: Math.max(0, (balance?.free_quota_daily || 10) - (balance?.free_quota_used || 0)),
  }));
}

/* ==================== DAILY CLAIM ==================== */

// 获取 UTC+8 时区的当日零点，返回 UTC ISO 字符串
function getUTC8DayStart() {
  const now = new Date();
  const utc8Ms = now.getTime() + 8 * 60 * 60 * 1000;
  const utc8Date = new Date(utc8Ms);
  const year = utc8Date.getUTCFullYear();
  const month = String(utc8Date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc8Date.getUTCDate()).padStart(2, '0');
  return new Date(`${year}-${month}-${day}T00:00:00+08:00`).toISOString();
}

async function handleClaimDaily(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }

  const todayStart = getUTC8DayStart();
  const now = new Date().toISOString();

  try {
    // 原子性检查：仅在未签到或上次签到早于今日零点时更新
    const updateResult = await env.DB.prepare(
      'UPDATE users SET last_claim = ? WHERE id = ? AND (last_claim IS NULL OR last_claim < ?)'
    ).bind(now, user.id, todayStart).run();

    if (updateResult.meta.changes === 0) {
      return createResponse(JSON.stringify({
        claimed: false,
        error: 'already_claimed',
      }), 200);
    }

    // 增加 10 积分
    await env.DB.prepare(
      'UPDATE balances SET amount = amount + 10 WHERE user_id = ?'
    ).bind(user.id).run();

    // 获取最新余额
    const balance = await env.DB.prepare(
      'SELECT amount FROM balances WHERE user_id = ?'
    ).bind(user.id).first();

    return createResponse(JSON.stringify({
      claimed: true,
      credits: 10,
      balance: balance?.amount || 0,
    }), 200);
  } catch (e) {
    console.error('Claim daily error:', e);
    return createResponse(JSON.stringify({ error: 'claim_failed' }), 500);
  }
}

/* ==================== VOUCHER REDEMPTION ==================== */

async function handleRedeemVoucher(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return createResponse(JSON.stringify({ error: 'Invalid JSON' }), 400);
  }

  const { voucher_text } = body;
  if (!voucher_text || typeof voucher_text !== 'string') {
    return createResponse(JSON.stringify({ error: 'voucher_text required' }), 400);
  }

  try {
    const voucher = await env.DB.prepare(
      'SELECT * FROM vouchers WHERE voucher_text = ?'
    ).bind(voucher_text.trim()).first();

    if (!voucher) {
      return createResponse(JSON.stringify({ error: 'invalid_voucher' }), 400);
    }

    const today = new Date().toISOString().split('T')[0];
    if (voucher.expire_date < today) {
      return createResponse(JSON.stringify({ error: 'expired' }), 400);
    }

    if (voucher.times_remaining <= 0) {
      return createResponse(JSON.stringify({ error: 'no_remaining' }), 400);
    }

    const already = await env.DB.prepare(
      'SELECT 1 FROM voucher_redemptions WHERE user_id = ? AND voucher_id = ?'
    ).bind(user.id, voucher.id).first();

    if (already) {
      return createResponse(JSON.stringify({ error: 'already_redeemed' }), 400);
    }

    await env.DB.prepare(
      'UPDATE vouchers SET times_remaining = times_remaining - 1 WHERE id = ?'
    ).bind(voucher.id).run();

    await env.DB.prepare(
      'INSERT INTO voucher_redemptions (user_id, voucher_id) VALUES (?, ?)'
    ).bind(user.id, voucher.id).run();

    await env.DB.prepare(
      'UPDATE balances SET amount = amount + ? WHERE user_id = ?'
    ).bind(voucher.credit_amount, user.id).run();

    await env.DB.prepare(
      "INSERT INTO transactions (user_id, type, amount, description) VALUES (?, 'recharge', ?, ?)"
    ).bind(user.id, voucher.credit_amount, `Voucher: ${voucher_text.trim()}`).run();

    const balance = await env.DB.prepare(
      'SELECT amount FROM balances WHERE user_id = ?'
    ).bind(user.id).first();

    return createResponse(JSON.stringify({
      success: true,
      credits: voucher.credit_amount,
      balance: balance?.amount || 0,
    }), 200);

  } catch (e) {
    console.error('Redeem voucher error:', e);
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
      return createResponse(JSON.stringify({ error: 'already_redeemed' }), 400);
    }
    return createResponse(JSON.stringify({ error: 'redeem_failed' }), 500);
  }
}

/* ==================== VISITOR CREDITS ==================== */

// Init 新用户限流（仅限制新注册，不影响老用户）
const initRateLimitMap = new Map();
const INIT_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1分钟
const INIT_RATE_LIMIT_MAX = 10;              // 每IP哈希每分钟最多10个新用户

function checkInitRateLimit(ipHash) {
  const now = Date.now();
  const record = initRateLimitMap.get(ipHash);
  if (!record || now - record.windowStart > INIT_RATE_LIMIT_WINDOW_MS) {
    initRateLimitMap.set(ipHash, { windowStart: now, count: 1 });
    return { allowed: true };
  }
  if (record.count >= INIT_RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((record.windowStart + INIT_RATE_LIMIT_WINDOW_MS - now) / 1000) };
  }
  record.count++;
  return { allowed: true };
}

function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function hashIP(ip) {
  try {
    const encoder = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', encoder.encode(ip));
    const hash = btoa(String.fromCharCode(...new Uint8Array(buf)));
    return hash.slice(0, 16);
  } catch (e) {
    return ip.slice(0, 8);
  }
}

async function ensureVisitorTables(env) {
  try {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS visitors (
      visitor_id TEXT PRIMARY KEY,
      credits INTEGER DEFAULT 100,
      total_used INTEGER DEFAULT 0,
      first_visit DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_visit DATETIME,
      ip_hash TEXT,
      visit_count INTEGER DEFAULT 1,
      is_blocked BOOLEAN DEFAULT 0,
      linked_user_id INTEGER,
      fp_type TEXT DEFAULT 'oss'
    )`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS visitor_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      credits_used INTEGER DEFAULT 1,
      ip_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_visitors_ip_hash ON visitors(ip_hash)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_visitors_linked_user ON visitors(linked_user_id)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_visitor_logs_visitor ON visitor_logs(visitor_id)`).run();
    await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_visitor_logs_created ON visitor_logs(created_at)`).run();
  } catch (e) {
    console.error('[ensureVisitorTables] error:', e);
  }
}

async function handleVisitorInit(request, env) {
  try {
    await ensureVisitorTables(env);
    const body = await request.json();
    const visitorId = body.visitorId;
    const fpType = body.fpType || 'oss';
    if (!visitorId) {
      return createResponse(JSON.stringify({ error: 'visitorId required' }), 400);
    }

    const ip = getClientIP(request);
    const ipHash = await hashIP(ip);

    let visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
      .bind(visitorId)
      .first();

    if (!visitor) {
      // 新用户限流检查（不影响老用户）
      const rl = checkInitRateLimit(ipHash);
      if (!rl.allowed) {
        return createResponse(JSON.stringify({
          error: 'The server is too popular now! Please refresh 1 minute later to get your free credits, thanks!'
        }), 429);
      }

      await env.DB.prepare(
        'INSERT INTO visitors (visitor_id, credits, total_used, first_visit, last_visit, ip_hash, visit_count, fp_type) VALUES (?, 100, 0, datetime("now"), datetime("now"), ?, 1, ?)'
      ).bind(visitorId, ipHash, fpType).run();
      visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
        .bind(visitorId)
        .first();
      return createResponse(JSON.stringify({
        visitorId,
        credits: visitor.credits,
        totalUsed: visitor.total_used,
        isNew: true
      }));
    }

    await env.DB.prepare(
      'UPDATE visitors SET last_visit = datetime("now"), visit_count = visit_count + 1, ip_hash = ?, fp_type = ? WHERE visitor_id = ?'
    ).bind(ipHash, fpType, visitorId).run();

    // 已绑定用户：不暴露 credits，提示登录
    if (visitor.linked_user_id) {
      return createResponse(JSON.stringify({
        visitorId,
        credits: null,
        totalUsed: visitor.total_used,
        isNew: false,
        isBound: true,
        requiresLogin: true
      }));
    }

    return createResponse(JSON.stringify({
      visitorId,
      credits: visitor.credits,
      totalUsed: visitor.total_used,
      isNew: false
    }));
  } catch (err) {
    return createResponse(JSON.stringify({ error: err.message }), 500);
  }
}

async function handleVisitorBalance(request, env) {
  const visitorId = request.headers.get('X-Visitor-ID');
  if (!visitorId) {
    return createResponse(JSON.stringify({ error: 'X-Visitor-ID required' }), 400);
  }
  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first();
  if (!visitor) {
    return createResponse(JSON.stringify({ credits: 0, totalUsed: 0 }));
  }
  
  // 已绑定用户：返回 user balance（或提示登录）
  if (visitor.linked_user_id) {
    const user = await getUserFromRequest(request, env);
    if (user && user.id === visitor.linked_user_id) {
      // 已登录且匹配，返回真实 balance
      const balance = await env.DB.prepare('SELECT * FROM balances WHERE user_id = ?')
        .bind(visitor.linked_user_id)
        .first();
      const freeLeft = Math.max(0, (balance?.free_quota_daily || 10) - (balance?.free_quota_used || 0));
      return createResponse(JSON.stringify({
        credits: (balance?.amount || 0) + freeLeft,
        totalUsed: balance?.free_quota_used || 0,
        isBound: true,
      }));
    }
    // 未登录或登录的是其他账号：不暴露余额
    return createResponse(JSON.stringify({
      credits: null,
      totalUsed: 0,
      isBound: true,
      requiresLogin: true,
    }));
  }
  
  return createResponse(JSON.stringify({
    credits: visitor.credits,
    totalUsed: visitor.total_used,
    isBound: false,
  }));
}

async function handleVisitorAddCredit(request, env) {
  const url = new URL(request.url);
  const adminKey = url.searchParams.get('key');
  if (adminKey !== 'moyuxiaowuMoneter') {
    return createResponse(JSON.stringify({ error: 'Unauthorized' }), 403);
  }

  const visitorId = request.headers.get('X-Visitor-ID');
  if (!visitorId) {
    return createResponse(JSON.stringify({ error: 'X-Visitor-ID required' }), 400);
  }
  const addCredit = parseInt(url.searchParams.get('addcredit')) || 0;
  if (addCredit <= 0) {
    return createResponse(JSON.stringify({ error: 'Invalid addcredit value' }), 400);
  }

  await env.DB.prepare(
    'UPDATE visitors SET credits = credits + ? WHERE visitor_id = ?'
  ).bind(addCredit, visitorId).run();

  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first();

  return createResponse(JSON.stringify({
    visitorId,
    credits: visitor?.credits || 0,
    added: addCredit
  }));
}

async function checkAndConsumeVisitorCredits(visitorId, request, env, action = 'generate', cost = 1) {
  await ensureVisitorTables(env);
  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first();

  if (!visitor) return { allowed: false, reason: 'Visitor not found' };
  if (visitor.is_blocked) return { allowed: false, reason: 'Visitor blocked' };
  
  // 已绑定用户：校验 JWT 并转扣 user balance（循环扣费）
  if (visitor.linked_user_id) {
    const user = await getUserFromRequest(request, env);
    const targetUserId = user ? user.id : visitor.linked_user_id;
    for (let i = 0; i < cost; i++) {
      const result = await checkAndConsumeQuota(targetUserId, env);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  }
  
  // 未绑定：走原有 visitor credits 逻辑
  if (visitor.credits < cost) return { allowed: false, reason: 'Insufficient credits' };

  await env.DB.prepare(
    'UPDATE visitors SET credits = credits - ?, total_used = total_used + ?, last_visit = datetime("now") WHERE visitor_id = ?'
  ).bind(cost, cost, visitorId).run();

  await env.DB.prepare(
    'INSERT INTO visitor_logs (visitor_id, action, credits_used) VALUES (?, ?, ?)'
  ).bind(visitorId, action, cost).run();

  return { allowed: true, creditsLeft: visitor.credits - cost };
}

// 仅检查 visitor 额度，不扣除（用于 pdf_generate 延迟扣费）
async function peekVisitorCredits(visitorId, request, env, cost = 1) {
  await ensureVisitorTables(env);
  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first();

  if (!visitor) return { allowed: false, reason: 'Visitor not found' };
  if (visitor.is_blocked) return { allowed: false, reason: 'Visitor blocked' };
  
  // 已绑定用户：校验 JWT 并检查 user balance
  if (visitor.linked_user_id) {
    const user = await getUserFromRequest(request, env);
    if (user) {
      // 当前已登录（不管是不是原来绑定的用户），走当前用户的 balance
      return await peekUserQuota(user.id, env, cost);
    }
    // 未登录状态，提示需要登录
    return { allowed: false, reason: 'Visitor bound to another account, please login' };
  }
  
  // 未绑定：检查 credits 是否足够
  if (visitor.credits < cost) return { allowed: false, reason: 'Insufficient credits' };
  return { allowed: true, creditsLeft: visitor.credits };
}

// 扣除 visitor 额度（带并发保护）
async function deductVisitorCredits(visitorId, request, env, action = 'pdf_generate', cost = 1) {
  await ensureVisitorTables(env);
  const visitor = await env.DB.prepare('SELECT * FROM visitors WHERE visitor_id = ?')
    .bind(visitorId)
    .first();

  if (!visitor) return false;
  if (visitor.is_blocked) return false;
  
  // 已绑定用户：转扣当前登录用户的 balance（支持切换账户，循环扣费）
  if (visitor.linked_user_id) {
    const user = request ? await getUserFromRequest(request, env) : null;
    const targetUserId = user ? user.id : visitor.linked_user_id;
    for (let i = 0; i < cost; i++) {
      const ok = await deductUserQuota(targetUserId, env, action);
      if (!ok) return false;
    }
    return true;
  }
  
  // 未绑定：条件更新防并发超扣
  const result = await env.DB.prepare(
    'UPDATE visitors SET credits = credits - ?, total_used = total_used + ?, last_visit = datetime("now") WHERE visitor_id = ? AND credits >= ?'
  ).bind(cost, cost, visitorId, cost).run();
  
  if (result.meta?.changes === 0) return false;
  
  await env.DB.prepare(
    'INSERT INTO visitor_logs (visitor_id, action, credits_used) VALUES (?, ?, ?)'
  ).bind(visitorId, action, cost).run();
  
  return true;
}

/* ==================== GCP AUTH ==================== */

function base64urlFromObject(obj) {
  return base64urlFromString(JSON.stringify(obj));
}

function base64urlFromString(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessToken(env) {
  if (!env.GCP_CLIENT_EMAIL || !env.GCP_PRIVATE_KEY) {
    throw new Error('GCP credentials not configured: set GCP_CLIENT_EMAIL and GCP_PRIVATE_KEY in secrets or .dev.vars');
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.GCP_CLIENT_EMAIL,
    sub: env.GCP_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const toSign = `${base64urlFromObject(header)}.${base64urlFromObject(payload)}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBuffer(env.GCP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(toSign)
  );

  const jwt = `${toSign}.${base64urlFromBuffer(sigBuffer)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

function pemToBuffer(pem) {
  const normalized = pem.replace(/\\n/g, '\n');
  const b64 = normalized
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/* ==================== GCS ==================== */

async function uploadToGCS(buffer, name, token, env) {
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${env.GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/pdf',
    },
    body: buffer,
  });

  if (!res.ok) throw new Error(await res.text());
  return `gs://${env.GCS_BUCKET}/${name}`;
}

async function deleteFromGCS(name, token, env) {
  const url = `https://storage.googleapis.com/storage/v1/b/${env.GCS_BUCKET}/o/${encodeURIComponent(name)}`;
  
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete GCS file: ${await res.text()}`);
  }
}

/* ==================== VERTEX AI ==================== */

async function streamVertex(fileUri, prompt, env, token, modelIdOverride = null, thinkingConfigOverride = null) {
  const modelId = modelIdOverride || env.GCP_MODEL_ID || 'gemini-2.5-flash-lite';
  const isGlobal = env.GCP_LOCATION === 'global';
  const host = isGlobal ? 'aiplatform.googleapis.com' : `${env.GCP_LOCATION}-aiplatform.googleapis.com`;
  const location = isGlobal ? 'global' : env.GCP_LOCATION;
  const endpoint = `https://${host}/v1/projects/${env.GCP_PROJECT_ID}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            file_data: {
              mime_type: 'application/pdf',
              file_uri: fileUri,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.5,
      responseMimeType: 'application/json',
      thinkingConfig: thinkingConfigOverride || {
        thinkingBudget: -1,
      },
    },
  };

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function streamVertexFromText(text, prompt, env, token) {
  const modelId = env.GCP_MODEL_ID || 'gemini-2.5-flash-lite';
  const isGlobal = env.GCP_LOCATION === 'global';
  const host = isGlobal ? 'aiplatform.googleapis.com' : `${env.GCP_LOCATION}-aiplatform.googleapis.com`;
  const location = isGlobal ? 'global' : env.GCP_LOCATION;
  const endpoint = `https://${host}/v1/projects/${env.GCP_PROJECT_ID}/locations/${location}/publishers/google/models/${modelId}:streamGenerateContent`;

  const fullPrompt = `${prompt}\n\n[Study Material Content]:\n${text}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: fullPrompt },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.5,
      responseMimeType: 'application/json',
      thinkingConfig: {
        thinkingLevel: 'LOW',
      },
    },
  };

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/* ==================== DeepSeek ==================== */

async function callDeepSeek(messages, apiKey, chunkId = null) {
  const payload = {
    model: 'deepseek-v4-flash',
    messages: messages,
    stream: false,
    temperature: 0.7,
  };

  console.log(`[DEBUG] callDeepSeek called, chunkId=${chunkId}, messages_count=${messages?.length || 0}`);
  
  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[DEBUG] DeepSeek API error for chunk ${chunkId}: status=${response.status}, response=${errorText}`);
    throw new Error(`Chunk ${chunkId}: AI service error, status: ${response.status}, details: ${errorText}`);
  }

  const result = await response.json();
  console.log(`[DEBUG] DeepSeek API success for chunk ${chunkId}, response_length=${result?.choices?.[0]?.message?.content?.length || 0}`);
  return result;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callDeepSeekWithRetry(messages, apiKey, maxRetries = 2) {
  let lastError;
  
  console.log(`[DEBUG] callDeepSeekWithRetry starting, maxRetries=${maxRetries}`);
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`[DEBUG] Retrying DeepSeek call, attempt ${attempt + 1}/${maxRetries + 1}...`);
        await sleep(attempt * 1000);
      }
      
      const result = await callDeepSeek(messages, apiKey);
      console.log(`[DEBUG] DeepSeek call succeeded on attempt ${attempt + 1}`);
      return result;
    } catch (error) {
      lastError = error;
      console.error(`[DEBUG] DeepSeek call attempt ${attempt + 1} failed:`, error.message);
    }
  }
  
  console.error(`[DEBUG] All ${maxRetries + 1} attempts failed, throwing last error`);
  throw lastError;
}

/* ==================== DeepSeek Streaming ==================== */

async function streamDeepSeekJSON(messages, apiKey, onChunk = null) {
  const payload = {
    model: 'deepseek-v4-flash',
    messages,
    stream: true,
    max_tokens: 32000,
    response_format: { type: 'json_object' },
    thinking: { type: 'enabled' },
    temperature: 0.7,
  };

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status}, ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let jsonBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) continue;
          if (delta?.content) {
            jsonBuffer += delta.content;
            if (onChunk) onChunk(delta.content);
          }
        } catch (e) {
          // ignore parse error
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(jsonBuffer);
}

async function streamDeepSeekJSONWithRetry(messages, apiKey, maxRetries = 2, onChunk = null) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await sleep(attempt * 1000);
      }
      return await streamDeepSeekJSON(messages, apiKey, onChunk);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.error(`[DEBUG] streamDeepSeekJSON attempt ${attempt + 1} failed:`, err.message);
    }
  }
}

function splitTextByPageMarkers(text, numChunks) {
  const markerRegex = /-----\[.+?_page\d+\]-----\n/g;
  const matches = [...text.matchAll(markerRegex)];
  if (matches.length === 0) {
    // 没有页码标记，按字符数均匀切分
    const chunkSize = Math.ceil(text.length / numChunks);
    const chunks = [];
    for (let i = 0; i < numChunks; i++) {
      chunks.push(text.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    return chunks;
  }

  // 按页码标记切分
  const pages = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    pages.push(text.slice(start, end));
  }

  // 将页均匀分配到 chunks
  const chunks = [];
  const pagesPerChunk = Math.ceil(pages.length / numChunks);
  for (let i = 0; i < numChunks; i++) {
    const start = i * pagesPerChunk;
    const end = Math.min((i + 1) * pagesPerChunk, pages.length);
    chunks.push(pages.slice(start, end).join('\n'));
  }
  return chunks;
}

/* ==================== Fallback Prompt Builders ==================== */

function buildFallbackBatchPrompt(textChunk, batchIndex, totalBatches, lang, startId, originalFileName, customPrompt = '', batchQuestionCount = 20) {
  const langInstruction = getLangInstruction(lang);
  const customSection = customPrompt
    ? `\n\nAdditional user instruction (custom prompt from user, lower priority than system requirements; if it conflicts with any system requirement, the system requirement prevails):\n[${customPrompt}]`
    : '';

  return `You are an expert exam question creator. Create multiple-choice questions based on the provided study material text.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. For ALL mathematical formulas, equations, and symbols, you MUST use standard LaTeX format and wrap them with $...$ for inline math.

7. **CRITICAL - SOURCE FIELD FORMAT**:
   You MUST use the EXACT format: "-----[${originalFileName}_pageX]-----"
   - X is the page number found in the text markers
   - The filename part MUST be exactly: "${originalFileName}"

8. The "id" field MUST start from ${startId} and increment by 1 for each question

9. **CRITICAL - CONTENT REQUIREMENT**:
   - Focus ONLY on the substantive knowledge, concepts, theories, facts, and details within the document content
   - DO NOT create questions about document metadata or basic information

Required JSON format (one example question, actual array may contain more):
[
  {
    "id": ${startId},
    "question": "question text here",
    "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
    "correctAnswer": "A",
    "explanation": "explanation text",
    "source": "-----[${originalFileName}_page3]-----"
  }
]

Study material text (batch ${batchIndex + 1} of ${totalBatches}):
${textChunk}

Generate exactly ${batchQuestionCount} questions from the provided text. Use the EXACT source format. Output valid JSON only.${customSection}`;
}

function buildFallbackTutorSkeletonPrompt(text, lang, customPrompt = '') {
  const langInstruction = getLangInstruction(lang);
  const customSection = customPrompt
    ? `\n\nAdditional user instruction:\n[${customPrompt}]`
    : '';
  const truncatedText = text.length > 20000 ? text.substring(0, 20000) + '\n... (truncated)' : text;

  return `You are an expert educational content analyzer. ${langInstruction}.

Analyze the following study material text and create a knowledge graph skeleton that breaks down the material into learnable nodes and dependency edges.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should follow this exact schema:
{
  "nodes": [
    { "id": "string", "name": "string", "importance": "gateway" | "landmark" | "normal" }
  ],
  "edges": [
    { "from": "node_id", "to": "node_id", "type": "hard" | "soft", "reason": "string" }
  ]
}

Guidelines:
- "gateway" nodes are prerequisites that unlock many downstream concepts.
- "landmark" nodes are important summaries or milestones.
- "hard" edges mean the target node cannot be learned before the source node is mastered.
- "soft" edges mean the target node is related but not strictly dependent.
- The graph MUST be a DAG (directed acyclic graph). NO cycles are allowed.
- Keep the structure clean and hierarchical like a learning path or tree. AVOID dense spiderweb-like cross-connections.
- Each node should have at most 3 outgoing hard edges and at most 2 outgoing soft edges.
- Use soft edges sparingly — only when two concepts are genuinely related but not prerequisite-dependent.
- Every non-root node MUST have at least one incoming hard edge. Do NOT create nodes that rely solely on soft edges for connectivity. If a node has prerequisites, they must be hard edges.
- Intelligently determine the number of nodes based on content complexity:
  - Short/simple material: 5–10 nodes
  - Medium material: 10–25 nodes
  - Complex/long material: 25–50 nodes
- Maximum node count: 50.

Study material text:
${truncatedText}${customSection}`;
}

function buildFallbackTutorNodePrompt(text, node, prevExitHooks, lang) {
  const langInstruction = getLangInstruction(lang);
  const prevContext = prevExitHooks.length > 0
    ? `\n\nPrevious nodes summary:\n${prevExitHooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '';
  const truncatedText = text.length > 15000 ? text.substring(0, 15000) + '\n... (truncated)' : text;

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

Create the learning content for the following node:
- Node ID: ${node.id}
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}${prevContext}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should follow this exact schema:
{
  "nodeId": "${node.id}",
  "introQuestion": "An engaging warm-up question.",
  "coreConcepts": [
    { "title": "string", "content": "string", "source": "" }
  ],
  "checkActivities": [
    { "type": "choice", "question": "string", "options": ["option1", "option2", "option3"], "correct": 0 }
  ],
  "exitHook": "A self-contained summary of what the learner now knows after this node."
}

Guidelines:
- coreConcepts should have 2-4 items.
- checkActivities should have 1-3 items. For "landmark" importance, you may return an empty array [].
- EXITHOOK REQUIREMENT: The exitHook must be an independent, complete summary of this node's knowledge.
- For ALL mathematical formulas, use standard LaTeX format and wrap them with $...$.

Study material text:
${truncatedText}`;
}

function buildFallbackTutorNodePromptRetry(text, node, lang) {
  const langInstruction = getLangInstruction(lang);
  const truncatedText = text.length > 8000 ? text.substring(0, 8000) + '\n... (truncated)' : text;

  return `You are an expert tutor. ${langInstruction} ONLY for ALL output fields.

Create a SHORT learning content for this node:
- Node ID: ${node.id}
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY.
2. Output ONLY a valid JSON object. No markdown, no code blocks.
3. Keep content concise to avoid truncation.

The JSON should follow this exact schema:
{
  "nodeId": "${node.id}",
  "introQuestion": "string",
  "coreConcepts": [
    { "title": "string", "content": "string", "source": "" }
  ],
  "checkActivities": [],
  "exitHook": "string (max 150 words)"
}

Study material text:
${truncatedText}`;
}

function buildFallbackTutorBatchPrompt(text, nodes, parentMap, contentMap, lang) {
  const langInstruction = getLangInstruction(lang);
  const truncatedText = text.length > 12000 ? text.substring(0, 12000) + '\n... (truncated)' : text;

  const nodeSections = nodes.map(node => {
    const parentIds = parentMap.get(node.id) || [];
    const parentHooks = parentIds
      .map(pid => contentMap.get(pid)?.exitHook)
      .filter(Boolean);

    const prevContext = parentHooks.length > 0
      ? `\nParent node summaries:\n${parentHooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : '\nThis is a root node with no prerequisites.';

    return `--- NODE: ${node.id} ---
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}${prevContext}
Generate this node's content following the same schema as above.`;
  }).join('\n\n');

  const nodeIdList = nodes.map(n => `"${n.id}"`).join(', ');

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

Create the learning content for the following nodes. Each node is independent and can be generated in parallel, but some nodes rely on the exitHook summaries of their parent nodes (provided below).

${nodeSections}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should contain top-level keys for each node ID (${nodeIdList}). Under each key, use this exact schema:
{
  "${nodes[0]?.id || 'nodeId'}": {
    "nodeId": "${nodes[0]?.id || 'nodeId'}",
    "introQuestion": "...",
    "coreConcepts": [{ "title": "string", "content": "string", "source": "" }],
    "checkActivities": [{ "type": "choice", "question": "string", "options": ["...", "...", "..."], "correct": 0 }],
    "exitHook": "A self-contained summary..."
  }
}

Guidelines:
- coreConcepts should have 2-4 items.
- checkActivities should have 1-3 items. For "landmark" importance, you may return an empty array [].
- EXITHOOK REQUIREMENT: The exitHook must be an independent, complete summary.
- For ALL mathematical formulas, use standard LaTeX format and wrap them with $...$.

Study material text:
${truncatedText}`;
}

/* ==================== PDF Generate Helpers ==================== */

function getLangInstruction(lang) {
  if (lang === 'zh') return '使用中文';
  if (lang === 'zh-TW') return '使用繁體中文';
  if (lang === 'ko') return '한국어를 사용하세요';
  return 'Use English';
}

/* ==================== Skeleton Sanitization ==================== */

function wouldCreateCycle(edges, newEdge) {
  const adj = new Map();
  edges.forEach(e => {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  });

  const visited = new Set();
  const stack = [newEdge.to];
  while (stack.length > 0) {
    const curr = stack.pop();
    if (curr === newEdge.from) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);

    const neighbors = adj.get(curr) || [];
    for (const n of neighbors) {
      if (!visited.has(n)) stack.push(n);
    }
  }
  return false;
}

function sanitizeSkeleton(skeleton) {
  if (!skeleton || !Array.isArray(skeleton.nodes) || !Array.isArray(skeleton.edges)) {
    return skeleton;
  }

  const nodeIds = new Set(skeleton.nodes.map(n => n.id));

  // 0. 兜底：把只有 soft 依赖、没有 hard 依赖的节点，随机升级一条 soft 边为 hard
  const hardInCounts = new Map();
  const softInIndices = new Map();
  skeleton.nodes.forEach(n => {
    hardInCounts.set(n.id, 0);
    softInIndices.set(n.id, []);
  });

  skeleton.edges.forEach((edge, idx) => {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return;
    if (edge.type === 'hard') {
      hardInCounts.set(edge.to, hardInCounts.get(edge.to) + 1);
    } else {
      softInIndices.get(edge.to).push(idx);
    }
  });

  for (const node of skeleton.nodes) {
    if (hardInCounts.get(node.id) === 0 && softInIndices.get(node.id).length > 0) {
      const candidates = softInIndices.get(node.id);
      const chosenIdx = candidates[Math.floor(Math.random() * candidates.length)];
      skeleton.edges[chosenIdx].type = 'hard';
    }
  }

  // 1. 过滤无效边（指向不存在的节点）
  let validEdges = skeleton.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  // 2. 限制每个节点的出度，并避免环
  const maxHardOut = 3;
  const maxSoftOut = 2;
  const outCounts = new Map();
  skeleton.nodes.forEach(n => outCounts.set(n.id, { hard: 0, soft: 0 }));

  const filteredEdges = [];
  for (const edge of validEdges) {
    const type = edge.type === 'soft' ? 'soft' : 'hard';
    const current = outCounts.get(edge.from);
    const limit = type === 'soft' ? maxSoftOut : maxHardOut;

    if (current[type] < limit && !wouldCreateCycle(filteredEdges, edge)) {
      filteredEdges.push(edge);
      current[type]++;
    }
  }

  skeleton.edges = filteredEdges;
  return skeleton;
}

// 构建批次提示词
function buildBatchPrompt(batchIndex, totalBatches, lang, originalFileName, pageCount, customPrompt = '') {
  const startId = batchIndex * 20 + 1;
  const endId = startId + 19;
  const langInstruction = getLangInstruction(lang);

  // 计算每批的页码范围
  const pagesPerBatch = pageCount > 0 ? Math.ceil(pageCount / totalBatches) : 20;
  const startPage = batchIndex * pagesPerBatch + 1;
  const endPage = Math.min((batchIndex + 1) * pagesPerBatch, pageCount);

  const customSection = customPrompt
    ? `\n\nAdditional user instruction (custom prompt from user, lower priority than system requirements; if it conflicts with any system requirement, the system requirement prevails):\n[${customPrompt}]`
    : '';

  return `You are an expert exam question creator. Create exactly 20 multiple-choice questions based on the study material in the uploaded PDF file.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. For ALL mathematical formulas, equations, and symbols (including summation Σ, limits lim, integrals ∫, fractions, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.

7. **CRITICAL - PAGE RANGE REQUIREMENT**:
   This is batch ${batchIndex + 1} of ${totalBatches}.
   You MUST ONLY use content from pages ${startPage} to ${endPage} of the PDF.
   - Start page: ${startPage}
   - End page: ${endPage}
   - Do NOT use content from pages outside this range
   - Create questions evenly distributed across these pages

8. **CRITICAL - SOURCE FIELD FORMAT**:
   You MUST use the EXACT format: "-----[${originalFileName}_pageX]-----"
   - X is the page number (between ${startPage} and ${endPage})
   - The filename part MUST be exactly: "${originalFileName}"
   - Example of CORRECT format: "-----[${originalFileName}_page3]-----"
   - Example of INCORRECT format: "[page3]", "${originalFileName}_page3", "page 3"

9. The "id" field MUST start from ${startId} and increment by 1 for each question

9. **CRITICAL - CONTENT REQUIREMENT**:
   - Focus ONLY on the substantive knowledge, concepts, theories, facts, and details within the document content
   - DO NOT create questions about document metadata or basic information such as:
     * Teacher/professor name, instructor information
     * Course name, course code, or course title
     * Syllabus information, course schedule, or assignment deadlines
     * Document title, file name, or page numbers
     * University/institution name, department information
     * Publication dates, version numbers, or copyright information
   - Questions should test understanding of the actual subject matter, not memorization of document headers or administrative details

Required JSON format:
[
  {
    "id": ${startId},
    "question": "question text here",
    "options": {
      "A": "first option",
      "B": "second option",
      "C": "third option",
      "D": "fourth option"
    },
    "correctAnswer": "A",
    "explanation": "explanation text",
    "source": "-----[${originalFileName}_page3]-----"
  }
]

Generate exactly 20 questions from pages ${startPage}-${endPage}. Use the EXACT source format with the hardcoded filename "${originalFileName}". Output valid JSON only.${customSection}`;
}

// 流式读取 batch 并转发给客户端
async function streamBatchToClient(vertexRes, sendSSE, batchName) {
  const reader = vertexRes.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';
  let fullTextBuffer = ''; // 用于累积完整的文本内容以解析 JSON
  let totalTokenCount = 0; // 累积 token 数量

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      rawBuffer += chunk;

      // 提取 text 内容并转发
      const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let match;
      while ((match = textRegex.exec(rawBuffer)) !== null) {
        try {
          const text = JSON.parse(`"${match[1]}"`);
          if (text) {
            // 转发给客户端
            await sendSSE({ type: `${batchName}_chunk`, data: text });
            // 累积到完整缓冲区用于后续解析
            fullTextBuffer += text;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }

      // 提取 usageMetadata 中的 token 数量
      const usageMatch = rawBuffer.match(/"usageMetadata"\s*:\s*\{[^}]*"totalTokenCount"\s*:\s*(\d+)/);
      if (usageMatch) {
        totalTokenCount = parseInt(usageMatch[1]);
      }

      // 清理已处理的缓冲区
      let lastIndex = 0;
      const allMatches = [...rawBuffer.matchAll(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g)];
      if (allMatches.length > 0) {
        const last = allMatches[allMatches.length - 1];
        lastIndex = last.index + last[0].length;
      }
      rawBuffer = rawBuffer.slice(lastIndex);
    }
  } finally {
    reader.releaseLock();
  }

  // 解析累积的完整文本，并附带 token 数量
  const questions = parseCompleteJSON(fullTextBuffer);
  return { questions, totalTokenCount };
}

// 解析批次响应（非流式，用于其他批次）
async function parseBatchResponse(vertexRes) {
  const reader = vertexRes.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';
  let fullTextBuffer = ''; // 用于累积完整的文本内容
  let totalTokenCount = 0; // 累积 token 数量

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });

      // 提取 text 内容
      const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let match;
      while ((match = textRegex.exec(rawBuffer)) !== null) {
        try {
          const text = JSON.parse(`"${match[1]}"`);
          if (text) {
            fullTextBuffer += text;
          }
        } catch (e) {
          // 忽略
        }
      }

      // 提取 usageMetadata 中的 token 数量
      const usageMatch = rawBuffer.match(/"usageMetadata"\s*:\s*\{[^}]*"totalTokenCount"\s*:\s*(\d+)/);
      if (usageMatch) {
        totalTokenCount = parseInt(usageMatch[1]);
      }

      // 清理已处理的缓冲区
      let lastIndex = 0;
      const allMatches = [...rawBuffer.matchAll(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g)];
      if (allMatches.length > 0) {
        const last = allMatches[allMatches.length - 1];
        lastIndex = last.index + last[0].length;
      }
      rawBuffer = rawBuffer.slice(lastIndex);
    }
  } finally {
    reader.releaseLock();
  }

  const questions = parseCompleteJSON(fullTextBuffer);
  return { questions, totalTokenCount };
}

// 解析完整 JSON
function parseCompleteJSON(buffer) {
  try {
    const arrayMatch = buffer.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      return JSON.parse(arrayMatch[0]);
    }
    return extractCompleteObjects(buffer);
  } catch (e) {
    return extractCompleteObjects(buffer);
  }
}

// 从文本中提取完整的 JSON 对象
function extractCompleteObjects(buffer) {
  const questions = [];
  const regex = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
  let match;

  while ((match = regex.exec(buffer)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.question && obj.options && obj.correctAnswer) {
        // 去重
        if (!questions.find(q => q.question === obj.question)) {
          questions.push(obj);
        }
      }
    } catch (e) {
      // 不完整的对象，跳过
    }
  }
  return questions;
}

/* ==================== Text Splitting Helpers ==================== */

// 根据文件类型和数量分割文本
function splitTextIntoChunks(text, numChunks, fileType, fileName) {
  // 判断文件类型分类
  const category = getFileCategory(fileType);
  
  if (category === 'page-based') {
    return splitByPages(text, numChunks, fileName);
  } else if (category === 'row-based') {
    return splitByRows(text, numChunks, fileName);
  } else {
    return overlapSplit(text, numChunks, 500);
  }
}

function getFileCategory(ext) {
  if (['pptx'].includes(ext)) return 'page-based';
  if (['xlsx', 'xls'].includes(ext)) return 'row-based';
  if (['docx', 'txt'].includes(ext)) return 'text-based';
  return 'unknown';
}

function splitByPages(text, numGroups, fileName) {
  const pageRegex = /-------------【.*?_(?:page|slide)(\d+)】-----------/g;
  const matches = [...text.matchAll(pageRegex)];
  
  if (matches.length === 0) {
    return overlapSplit(text, numGroups, 500);
  }
  
  const totalPages = matches.length;
  const basePagesPerGroup = Math.floor(totalPages / numGroups);
  const extraPages = totalPages % numGroups;
  
  const groups = [];
  let currentMatchIndex = 0;
  
  for (let i = 0; i < numGroups; i++) {
    const pagesInThisGroup = basePagesPerGroup + (i === numGroups - 1 ? extraPages : 0);
    
    if (pagesInThisGroup === 0 || currentMatchIndex >= matches.length) {
      continue;
    }
    
    const startMatch = matches[currentMatchIndex];
    const startIndex = startMatch.index;
    
    let endIndex;
    if (i === numGroups - 1) {
      endIndex = text.length;
    } else {
      const endMatchIndex = currentMatchIndex + pagesInThisGroup;
      if (endMatchIndex < matches.length) {
        endIndex = matches[endMatchIndex].index;
      } else {
        endIndex = text.length;
      }
    }
    
    groups.push(text.substring(startIndex, endIndex));
    currentMatchIndex += pagesInThisGroup;
  }
  
  while (groups.length < numGroups) {
    groups.push('');
  }
  
  return groups;
}

function splitByRows(text, numGroups, fileName) {
  const rowRegex = /-------------【.*?_row(\d+)】-----------/g;
  const matches = [...text.matchAll(rowRegex)];
  
  if (matches.length === 0) {
    return overlapSplit(text, numGroups, 500);
  }
  
  const totalRows = matches.length;
  const baseRowsPerGroup = Math.floor(totalRows / numGroups);
  const extraRows = totalRows % numGroups;
  
  const groups = [];
  let currentMatchIndex = 0;
  
  for (let i = 0; i < numGroups; i++) {
    const rowsInThisGroup = baseRowsPerGroup + (i === numGroups - 1 ? extraRows : 0);
    
    if (rowsInThisGroup === 0 || currentMatchIndex >= matches.length) {
      continue;
    }
    
    const startMatch = matches[currentMatchIndex];
    const startIndex = startMatch.index;
    
    let endIndex;
    if (i === numGroups - 1) {
      endIndex = text.length;
    } else {
      const endMatchIndex = currentMatchIndex + rowsInThisGroup;
      if (endMatchIndex < matches.length) {
        endIndex = matches[endMatchIndex].index;
      } else {
        endIndex = text.length;
      }
    }
    
    groups.push(text.substring(startIndex, endIndex));
    currentMatchIndex += rowsInThisGroup;
  }
  
  while (groups.length < numGroups) {
    groups.push('');
  }
  
  return groups;
}

function overlapSplit(text, numChunks, overlapChars = 500) {
  const chunks = [];
  if (numChunks > 1) {
    const baseChunkSize = Math.ceil(text.length / numChunks);
    for (let i = 0; i < numChunks; i++) {
      const start = Math.max(0, i * baseChunkSize - overlapChars);
      const end = Math.min(text.length, (i + 1) * baseChunkSize + overlapChars);
      const adjustedStart = findParagraphStart(text, start);
      const adjustedEnd = findParagraphEnd(text, end);
      chunks.push(text.substring(adjustedStart, adjustedEnd));
    }
  } else {
    chunks.push(text);
  }
  return chunks;
}

function findParagraphStart(text, pos) {
  const prevNewline = text.lastIndexOf('\n\n', pos);
  return prevNewline === -1 ? 0 : prevNewline + 2;
}

function findParagraphEnd(text, pos) {
  const nextNewline = text.indexOf('\n\n', pos);
  return nextNewline === -1 ? text.length : nextNewline;
}

// 构建文本生成的批次提示词
function buildTextBatchPrompt(batchIndex, totalBatches, lang, fileName, chunk) {
  const startId = batchIndex * 20 + 1;
  const langInstruction = getLangInstruction(lang);
  
  return `You are an expert exam question creator. Create exactly 20 multiple-choice questions based on the study material below.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. CRITICAL: For the "source" field, you MUST use the EXACT marker format shown in the text (e.g., "-------------【filename_page1】-----------" or "-------------【filename_section1】-----------")
7. For ALL mathematical formulas, equations, and symbols (including summation Σ, limits lim, integrals ∫, fractions, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.

8. **CRITICAL - CONTENT REQUIREMENT**:
   - Focus ONLY on the substantive knowledge, concepts, theories, facts, and details within the document content
   - DO NOT create questions about document metadata or basic information such as:
     * Teacher/professor name, instructor information
     * Course name, course code, or course title
     * Syllabus information, course schedule, or assignment deadlines
     * Document title, file name, or page numbers
     * University/institution name, department information
     * Publication dates, version numbers, or copyright information
   - Questions should test understanding of the actual subject matter, not memorization of document headers or administrative details

Required JSON format:
[
  {
    "id": ${startId},
    "question": "question text here",
    "options": {
      "A": "first option",
      "B": "second option", 
      "C": "third option",
      "D": "fourth option"
    },
    "correctAnswer": "A",
    "explanation": "explanation text",
    "source": "EXACT page marker from text"
  }
]

Study Material (Part ${batchIndex + 1} of ${totalBatches}):
${chunk.substring(0, 15000)}

Generate exactly 20 questions. Use the page markers in the text to indicate source location. Output valid JSON only.`;
}

/* ==================== Organize Helpers ==================== */

// 构建识别题目数量的提示词
function buildCountPrompt(text, lang) {
  const langInstruction = getLangInstruction(lang).replace('使用中文', '使用中文回答').replace('Use English', 'Answer in English').replace('使用繁體中文', '使用繁體中文回答').replace('한국어를 사용하세요', '한국어로 답변하세요');
  
  return `You are an expert at analyzing educational content. ${langInstruction}

Your task is to count how many multiple-choice questions are present in the following text.

Instructions:
1. Look for question patterns (e.g., numbers followed by questions, question marks, multiple choice options A/B/C/D)
2. Count ONLY complete multiple-choice questions (must have question text AND options)
3. Return ONLY a single number (e.g., "15" or "42")
4. If uncertain, provide your best estimate

Text to analyze (first 8000 characters):
${text.substring(0, 8000)}

Return ONLY the number of questions detected:`;
}

// 构建整理题目的提示词
function buildOrganizePrompt(chunk, startId, chunkIndex, totalChunks, lang) {
  const langInstruction = getLangInstruction(lang);
  
  return `You are an expert at organizing and structuring educational content. ${langInstruction}

Your task is to extract and organize multiple-choice questions from the provided text into a standardized JSON format.

CRITICAL REQUIREMENTS:
1. Extract ALL valid multiple-choice questions from the text
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer (if available in text, otherwise create a brief one)
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. The "id" field MUST start from ${startId} and increment by 1 for each question
7. The "source" field MUST be exactly: "用户上传题库"
8. For ALL mathematical formulas, equations, and symbols (including summation Σ, limits lim, integrals ∫, fractions, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.

Required JSON format:
[
  {
    "id": ${startId},
    "question": "question text here",
    "options": {
      "A": "first option",
      "B": "second option",
      "C": "third option",
      "D": "fourth option"
    },
    "correctAnswer": "A",
    "explanation": "explanation text"
  }
]

Text to process (Part ${chunkIndex + 1} of ${totalChunks}):
${chunk.substring(0, 12000)}

Extract and organize all valid questions. Output valid JSON only.`;
}

// 为 organize 分割文本
function splitTextForOrganize(text, numGroups) {
  // 优先按页码/slide分割
  const pageRegex = /-------------【.*?_(?:page|slide)(\d+)】-----------/g;
  const matches = [...text.matchAll(pageRegex)];
  
  if (matches.length >= numGroups) {
    return splitByPagesForOrganize(text, numGroups, matches);
  }
  
  // 其次按行号分割（Excel）
  const rowRegex = /-------------【.*?_row(\d+)】-----------/g;
  const rowMatches = [...text.matchAll(rowRegex)];
  
  if (rowMatches.length >= numGroups) {
    return splitByRowsForOrganize(text, numGroups, rowMatches);
  }
  
  // 默认按段落重叠分割
  return overlapSplitForOrganize(text, numGroups, 500);
}

function splitByPagesForOrganize(text, numGroups, matches) {
  const totalPages = matches.length;
  const basePagesPerGroup = Math.floor(totalPages / numGroups);
  const extraPages = totalPages % numGroups;
  
  const groups = [];
  let currentMatchIndex = 0;
  
  for (let i = 0; i < numGroups; i++) {
    const pagesInThisGroup = basePagesPerGroup + (i === numGroups - 1 ? extraPages : 0);
    
    if (pagesInThisGroup === 0 || currentMatchIndex >= matches.length) {
      groups.push('');
      continue;
    }
    
    const startMatch = matches[currentMatchIndex];
    const startIndex = startMatch.index;
    
    let endIndex;
    if (i === numGroups - 1 || currentMatchIndex + pagesInThisGroup >= matches.length) {
      endIndex = text.length;
    } else {
      const endMatch = matches[currentMatchIndex + pagesInThisGroup];
      endIndex = endMatch ? endMatch.index : text.length;
    }
    
    groups.push(text.substring(startIndex, endIndex));
    currentMatchIndex += pagesInThisGroup;
  }
  
  while (groups.length < numGroups) {
    groups.push('');
  }
  
  return groups;
}

function splitByRowsForOrganize(text, numGroups, matches) {
  const totalRows = matches.length;
  const baseRowsPerGroup = Math.floor(totalRows / numGroups);
  const extraRows = totalRows % numGroups;
  
  const groups = [];
  let currentMatchIndex = 0;
  
  for (let i = 0; i < numGroups; i++) {
    const rowsInThisGroup = baseRowsPerGroup + (i === numGroups - 1 ? extraRows : 0);
    
    if (rowsInThisGroup === 0 || currentMatchIndex >= matches.length) {
      groups.push('');
      continue;
    }
    
    const startMatch = matches[currentMatchIndex];
    const startIndex = startMatch.index;
    
    let endIndex;
    if (i === numGroups - 1 || currentMatchIndex + rowsInThisGroup >= matches.length) {
      endIndex = text.length;
    } else {
      const endMatch = matches[currentMatchIndex + rowsInThisGroup];
      endIndex = endMatch ? endMatch.index : text.length;
    }
    
    groups.push(text.substring(startIndex, endIndex));
    currentMatchIndex += rowsInThisGroup;
  }
  
  while (groups.length < numGroups) {
    groups.push('');
  }
  
  return groups;
}

function overlapSplitForOrganize(text, numChunks, overlapChars = 500) {
  const chunks = [];
  if (numChunks > 1) {
    const baseChunkSize = Math.ceil(text.length / numChunks);
    for (let i = 0; i < numChunks; i++) {
      const start = Math.max(0, i * baseChunkSize - overlapChars);
      const end = Math.min(text.length, (i + 1) * baseChunkSize + overlapChars);
      const adjustedStart = findParagraphStartForOrganize(text, start);
      const adjustedEnd = findParagraphEndForOrganize(text, end);
      chunks.push(text.substring(adjustedStart, adjustedEnd));
    }
  } else {
    chunks.push(text);
  }
  return chunks;
}

function findParagraphStartForOrganize(text, pos) {
  const prevNewline = text.lastIndexOf('\n\n', pos);
  return prevNewline === -1 ? 0 : prevNewline + 2;
}

function findParagraphEndForOrganize(text, pos) {
  const nextNewline = text.indexOf('\n\n', pos);
  return nextNewline === -1 ? text.length : nextNewline;
}

// 从文本中提取 JSON
function extractJSONFromText(text) {
  try {
    // 尝试直接解析
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch (e) {
    // 继续尝试其他方法
  }
  
  // 尝试匹配 JSON 数组
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      return JSON.parse(arrayMatch[0]);
    } catch (e) {
      // 继续
    }
  }
  
  // 尝试提取单个 JSON 对象
  const questions = [];
  const regex = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
  let match;
  
  while ((match = regex.exec(text)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.question && obj.options && obj.correctAnswer) {
        questions.push(obj);
      }
    } catch (e) {
      // 跳过不完整的对象
    }
  }
  
  return questions;
}

/* ==================== TUTOR GENERATE HELPERS ==================== */

async function streamVertexToText(vertexRes) {
  const reader = vertexRes.body.getReader();
  const decoder = new TextDecoder();
  let rawBuffer = '';
  let fullTextBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });

      const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
      let match;
      while ((match = textRegex.exec(rawBuffer)) !== null) {
        try {
          const text = JSON.parse(`"${match[1]}"`);
          if (text) fullTextBuffer += text;
        } catch (e) {}
      }

      let lastIndex = 0;
      const allMatches = [...rawBuffer.matchAll(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g)];
      if (allMatches.length > 0) {
        const last = allMatches[allMatches.length - 1];
        lastIndex = last.index + last[0].length;
      }
      rawBuffer = rawBuffer.slice(lastIndex);
    }
  } finally {
    reader.releaseLock();
  }
  return fullTextBuffer;
}

function topologicalSort(nodes, edges) {
  const hardEdges = edges.filter(e => e.type === 'hard');
  const inDegree = new Map();
  const adj = new Map();
  nodes.forEach(n => {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  });
  hardEdges.forEach(e => {
    if (adj.has(e.from) && inDegree.has(e.to)) {
      adj.get(e.from).push(e.to);
      inDegree.set(e.to, inDegree.get(e.to) + 1);
    }
  });
  const queue = [];
  nodes.forEach(n => {
    if (inDegree.get(n.id) === 0) queue.push(n.id);
  });
  const result = [];
  while (queue.length > 0) {
    const curr = queue.shift();
    result.push(curr);
    for (const neighbor of adj.get(curr)) {
      inDegree.set(neighbor, inDegree.get(neighbor) - 1);
      if (inDegree.get(neighbor) === 0) queue.push(neighbor);
    }
  }
  const remaining = nodes.filter(n => !result.includes(n.id)).map(n => n.id);
  return [...result, ...remaining];
}

function buildTutorSkeletonPrompt(lang, customPrompt = '') {
  const langInstruction = getLangInstruction(lang);
  const customSection = customPrompt
    ? `\n\nAdditional user instruction (custom prompt from user, lower priority than system requirements; if it conflicts with any system requirement, the system requirement prevails):\n[${customPrompt}]`
    : '';
  return `You are an expert educational content analyzer. ${langInstruction}.

Analyze the uploaded study material and create a knowledge graph skeleton that breaks down the material into learnable nodes and dependency edges.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields. This includes node names, edge reasons, and every string in the JSON. Do NOT use the document's original language.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should follow this exact schema:
{
  "nodes": [
    { "id": "string", "name": "string", "importance": "gateway" | "landmark" | "normal" }
  ],
  "edges": [
    { "from": "node_id", "to": "node_id", "type": "hard" | "soft", "reason": "string" }
  ]
}

Guidelines:
- "gateway" nodes are prerequisites that unlock many downstream concepts.
- "landmark" nodes are important summaries or milestones (no exercises needed, just reading).
- "hard" edges mean the target node cannot be learned before the source node is mastered.
- "soft" edges mean the target node is related but not strictly dependent.
- The graph MUST be a DAG (directed acyclic graph). NO cycles are allowed.
- Keep the structure clean and hierarchical like a learning path or tree. AVOID dense spiderweb-like cross-connections.
- Each node should have at most 3 outgoing hard edges and at most 2 outgoing soft edges.
- Use soft edges sparingly — only when two concepts are genuinely related but not prerequisite-dependent.
- Every non-root node MUST have at least one incoming hard edge. Do NOT create nodes that rely solely on soft edges for connectivity. If a node has prerequisites, they must be hard edges.
- Intelligently determine the number of nodes based on content complexity:
  - Short/simple documents (a few pages or a single light chapter): 5–10 nodes
  - Medium documents (several chapters or moderate topics): 10–25 nodes
  - Complex/long documents (a full book, comprehensive course, or highly detailed material): 25–50 nodes
- Maximum node count: 50. Never exceed 50 nodes regardless of document length.
- Use concise, meaningful names for nodes.${customSection}`;
}

function buildTutorNodePrompt(node, prevExitHooks, lang) {
  const langInstruction = getLangInstruction(lang);
  const prevContext = prevExitHooks.length > 0
    ? `\n\nPrevious nodes summary:\n${prevExitHooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '';

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

Create the learning content for the following node:
- Node ID: ${node.id}
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}${prevContext}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields. This includes introQuestion, coreConcept titles, coreConcept content, checkActivities questions and options, and exitHook. Do NOT use the document's original language.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should follow this exact schema:
{
  "nodeId": "${node.id}",
  "introQuestion": "An engaging warm-up question that hooks the learner.",
  "coreConcepts": [
    { "title": "string", "content": "string", "source": "string (exact page marker like -----[filename_pageN]-----)" }
  ],
  "checkActivities": [
    {
      "type": "choice",
      "question": "string",
      "options": ["option1", "option2", "option3"],
      "correct": 0
    }
  ],
  "exitHook": "A self-contained summary of what the learner now knows after this node."
}

Guidelines:
- introQuestion should be thought-provoking and related to the real world.
- coreConcepts should have 2-4 items, each explaining one key idea clearly.
- For each coreConcept, you MUST include a [source] field using the EXACT page marker format found in the document (e.g. -----[abc123_page3]-----). This allows the learner to trace back to the original material. If multiple pages are relevant, pick the most representative one.
- For ALL mathematical formulas, equations, Greek letters, and symbols (including \Omega, \sigma, \mathbb, \sum, integrals, inequalities, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.
- checkActivities should have 1-3 items. For "landmark" importance, you may return an empty array [].
- EXITHOOK REQUIREMENT (critical): The exitHook must be an independent, complete summary of this node's knowledge. It will be fed to downstream nodes as the ONLY context for writing their warm-up questions. It MUST capture the 1-2 most transferable core concepts in concise but fully informative language. A reader who only sees the exitHook (without the node title) should be able to understand what was learned. Do NOT make it a vague phrase like 'student understands derivatives'; instead write something like 'The student now knows that a derivative describes the instantaneous rate of change of a function at a single point, and geometrically represents the slope of the tangent line.'`;
}

function buildTutorBatchPrompt(nodes, parentMap, contentMap, lang) {
  const langInstruction = getLangInstruction(lang);

  const nodeSections = nodes.map(node => {
    const parentIds = parentMap.get(node.id) || [];
    const parentHooks = parentIds
      .map(pid => contentMap.get(pid)?.exitHook)
      .filter(Boolean);

    const prevContext = parentHooks.length > 0
      ? `\nParent node summaries:\n${parentHooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
      : '\nThis is a root node with no prerequisites.';

    return `--- NODE: ${node.id} ---
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}${prevContext}
Generate this node's content following the same schema as above.`;
  }).join('\n\n');

  const nodeIdList = nodes.map(n => `"${n.id}"`).join(', ');

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

Create the learning content for the following nodes. Each node is independent and can be generated in parallel, but some nodes rely on the exitHook summaries of their parent nodes (provided below).

${nodeSections}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields. This includes introQuestion, coreConcept titles, coreConcept content, checkActivities questions and options, and exitHook. Do NOT use the document's original language.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The response must be parseable as JSON.

The JSON should contain top-level keys for each node ID (${nodeIdList}). Under each key, use this exact schema:
{
  "${nodes[0]?.id || 'nodeId'}": {
    "nodeId": "${nodes[0]?.id || 'nodeId'}",
    "introQuestion": "An engaging warm-up question that hooks the learner.",
    "coreConcepts": [
      { "title": "string", "content": "string", "source": "string (exact page marker like -----[filename_pageN]-----)" }
    ],
    "checkActivities": [
      {
        "type": "choice",
        "question": "string",
        "options": ["option1", "option2", "option3"],
        "correct": 0
      }
    ],
    "exitHook": "A self-contained summary of what the learner now knows after this node."
  }
}

Guidelines:
- introQuestion should be thought-provoking and related to the real world.
- coreConcepts should have 2-4 items, each explaining one key idea clearly.
- For each coreConcept, you MUST include a [source] field using the EXACT page marker format found in the document (e.g. -----[abc123_page3]-----). If multiple pages are relevant, pick the most representative one.
- For ALL mathematical formulas, equations, Greek letters, and symbols, you MUST use standard LaTeX format and wrap them with $...$ for inline math.
- checkActivities should have 1-3 items. For "landmark" importance, you may return an empty array [].
- EXITHOOK REQUIREMENT (critical): The exitHook must be an independent, complete summary of this node's knowledge. It will be fed to downstream nodes as the ONLY context for writing their warm-up questions. It MUST capture the 1-2 most transferable core concepts in concise but fully informative language.`;
}

function buildTutorNodePromptRetry(node, lang) {
  const langInstruction = getLangInstruction(lang);
  return `You are an expert tutor. ${langInstruction} ONLY for ALL output fields.

Create a SHORT learning content for this node:
- Node ID: ${node.id}
- Node Name: ${node.name}
- Importance: ${node.importance || 'normal'}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY. Do NOT use the document's original language.
2. Output ONLY a valid JSON object. No markdown, no code blocks.
3. Keep content concise to avoid truncation.

The JSON should follow this exact schema:
{
  "nodeId": "${node.id}",
  "introQuestion": "string",
  "coreConcepts": [
    { "title": "string", "content": "string", "source": "" }
  ],
  "checkActivities": [],
  "exitHook": "string (max 150 words)"
}

Guidelines:
- coreConcepts: 1-2 short items only.
- exitHook: keep under 150 words.
- If you cannot determine a source page, leave source as an empty string.`;
}

/* ==================== Dependency-aware Batch Helpers ==================== */

function selectBatchNodes(nodes, inDegree, parentMap, contentMap, maxSize = 5) {
  const unprocessed = nodes.filter(n => !contentMap.has(n.id));
  unprocessed.sort((a, b) => inDegree.get(a.id) - inDegree.get(b.id));

  const batch = [];
  const batchIds = new Set();

  for (const node of unprocessed) {
    if (batch.length >= maxSize) break;

    const parents = parentMap.get(node.id) || [];
    const allParentsReady = parents.every(pid => contentMap.has(pid) || batchIds.has(pid));

    if (allParentsReady) {
      batch.push(node);
      batchIds.add(node.id);
    }
  }

  return batch;
}

function buildTutorDependencyBatchPrompt(nodes, parentMap, contentMap, lang) {
  const langInstruction = getLangInstruction(lang);
  const nodeIdSet = new Set(nodes.map(n => n.id));

  const internalDeps = [];
  for (const node of nodes) {
    const parents = parentMap.get(node.id) || [];
    const internalParents = parents.filter(pid => nodeIdSet.has(pid));
    if (internalParents.length > 0) {
      internalDeps.push(`- ${node.id} depends on: ${internalParents.join(', ')}`);
    }
  }

  const externalContexts = [];
  for (const node of nodes) {
    const parents = parentMap.get(node.id) || [];
    for (const pid of parents) {
      if (!nodeIdSet.has(pid) && contentMap.has(pid)) {
        const pc = contentMap.get(pid);
        if (pc && pc.exitHook) {
          externalContexts.push(`- ${pid}: ${pc.exitHook}`);
        }
      }
    }
  }
  const uniqueExternal = [...new Set(externalContexts)];

  const nodeSections = nodes.map(node => {
    const parents = parentMap.get(node.id) || [];
    const extCtx = parents
      .filter(pid => !nodeIdSet.has(pid) && contentMap.has(pid))
      .map(pid => {
        const pc = contentMap.get(pid);
        return `  - Parent ${pid}: ${pc.exitHook || ''}`;
      })
      .join('\n');

    return `--- NODE: ${node.id} ---
Node Name: ${node.name}
Importance: ${node.importance || 'normal'}
External prerequisites (already generated):
${extCtx || '  (none)'}
Generate this node's content following the schema below.`;
  }).join('\n\n');

  const nodeIdList = nodes.map(n => `"${n.id}"`).join(', ');

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

You will generate content for multiple nodes in ONE response. Some nodes in this batch depend on others that are also in this batch. You MUST generate them in dependency order within your reasoning, so that when you write a dependent node, the prerequisite node's full content (especially its exitHook) is already in your context.

${internalDeps.length > 0 ? `INTERNAL DEPENDENCIES (nodes within this batch that depend on each other):
${internalDeps.join('\n')}

IMPORTANT: Generate prerequisite nodes FIRST in your reasoning. Use their exitHook summaries as context when writing dependent nodes.` : 'These nodes have no internal dependencies and can be generated in any order.'}

${uniqueExternal.length > 0 ? `EXTERNAL CONTEXT (already generated parent nodes):
${uniqueExternal.join('\n')}` : ''}

${nodeSections}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields. Do NOT use the document's original language.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The JSON must contain top-level keys for each node ID (${nodeIdList}).
4. For nodes with internal dependencies, generate prerequisite nodes' content first in your reasoning, then use their full exitHook summaries when writing dependent nodes.

Under each node ID, use this exact schema:
{
  "${nodes[0]?.id || 'nodeId'}": {
    "nodeId": "...",
    "introQuestion": "An engaging warm-up question...",
    "coreConcepts": [
      { "title": "string", "content": "string", "source": "string (exact page marker)" }
    ],
    "checkActivities": [
      { "type": "choice", "question": "string", "options": ["...", "...", "..."], "correct": 0 }
    ],
    "exitHook": "A self-contained summary of what the learner now knows after this node."
  }
}

Guidelines:
- coreConcepts should have 2-4 items, each explaining one key idea clearly.
- For each coreConcept, include a [source] field using the EXACT page marker format found in the document.
- For ALL mathematical formulas, use standard LaTeX format wrapped with $...$.
- checkActivities should have 1-3 items. For "landmark" importance, return [].
- EXITHOOK REQUIREMENT: The exitHook must be an independent, complete summary. It will be used as context for downstream nodes.`;
}

function buildFallbackTutorDependencyBatchPrompt(text, nodes, parentMap, contentMap, lang) {
  const langInstruction = getLangInstruction(lang);
  const truncatedText = text.length > 12000 ? text.substring(0, 12000) + '\n... (truncated)' : text;
  const nodeIdSet = new Set(nodes.map(n => n.id));

  const internalDeps = [];
  for (const node of nodes) {
    const parents = parentMap.get(node.id) || [];
    const internalParents = parents.filter(pid => nodeIdSet.has(pid));
    if (internalParents.length > 0) {
      internalDeps.push(`- ${node.id} depends on: ${internalParents.join(', ')}`);
    }
  }

  const externalContexts = [];
  for (const node of nodes) {
    const parents = parentMap.get(node.id) || [];
    for (const pid of parents) {
      if (!nodeIdSet.has(pid) && contentMap.has(pid)) {
        const pc = contentMap.get(pid);
        if (pc && pc.exitHook) {
          externalContexts.push(`- ${pid}: ${pc.exitHook}`);
        }
      }
    }
  }
  const uniqueExternal = [...new Set(externalContexts)];

  const nodeSections = nodes.map(node => {
    const parents = parentMap.get(node.id) || [];
    const extCtx = parents
      .filter(pid => !nodeIdSet.has(pid) && contentMap.has(pid))
      .map(pid => {
        const pc = contentMap.get(pid);
        return `  - Parent ${pid}: ${pc.exitHook || ''}`;
      })
      .join('\n');

    return `--- NODE: ${node.id} ---
Node Name: ${node.name}
Importance: ${node.importance || 'normal'}
External prerequisites (already generated):
${extCtx || '  (none)'}
Generate this node's content following the schema below.`;
  }).join('\n\n');

  const nodeIdList = nodes.map(n => `"${n.id}"`).join(', ');

  return `You are an expert tutor creating micro-learning content. ${langInstruction}.

You will generate content for multiple nodes in ONE response. Some nodes in this batch depend on others that are also in this batch. You MUST generate them in dependency order within your reasoning, so that when you write a dependent node, the prerequisite node's full content (especially its exitHook) is already in your context.

${internalDeps.length > 0 ? `INTERNAL DEPENDENCIES (nodes within this batch that depend on each other):
${internalDeps.join('\n')}

IMPORTANT: Generate prerequisite nodes FIRST in your reasoning. Use their exitHook summaries as context when writing dependent nodes.` : 'These nodes have no internal dependencies and can be generated in any order.'}

${uniqueExternal.length > 0 ? `EXTERNAL CONTEXT (already generated parent nodes):
${uniqueExternal.join('\n')}` : ''}

${nodeSections}

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY for ALL fields.
2. Output ONLY a valid JSON object. No markdown, no code blocks, no extra explanations.
3. The JSON must contain top-level keys for each node ID (${nodeIdList}).
4. For nodes with internal dependencies, generate prerequisite nodes' content first in your reasoning, then use their full exitHook summaries when writing dependent nodes.

Under each node ID, use this exact schema:
{
  "${nodes[0]?.id || 'nodeId'}": {
    "nodeId": "...",
    "introQuestion": "...",
    "coreConcepts": [{ "title": "string", "content": "string", "source": "" }],
    "checkActivities": [{ "type": "choice", "question": "string", "options": ["...", "...", "..."], "correct": 0 }],
    "exitHook": "A self-contained summary..."
  }
}

Guidelines:
- coreConcepts should have 2-4 items.
- checkActivities should have 1-3 items. For "landmark" importance, return [].
- EXITHOOK REQUIREMENT: The exitHook must be an independent, complete summary.
- For ALL mathematical formulas, use standard LaTeX format and wrap them with $...$.

Study material text:
${truncatedText}`;
}

function safeParseJSON(text) {
  try {
    // Try direct parse first
    return JSON.parse(text);
  } catch (e) {
    // Try extracting JSON object
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

/* ==================== MOODLE API ==================== */

async function fetchMoodle(functionName, params, baseUrl, token) {
  const form = new URLSearchParams();
  form.append('wstoken', token);
  form.append('wsfunction', functionName);
  form.append('moodlewsrestformat', 'json');
  for (const [key, value] of Object.entries(params)) {
    form.append(key, value);
  }

  const response = await fetch(`${baseUrl}/webservice/rest/server.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'GPA-Buddy-Worker/1.0',
    },
    body: form.toString(),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Moodle API HTTP error: ${response.status}, body: ${responseText.slice(0, 200)}`);
  }

  let result;
  try {
    result = JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Moodle API returned non-JSON (check Moodle wwwroot config): ${responseText.slice(0, 200)}`);
  }

  if (result && typeof result === 'object' && (result.exception || result.error)) {
    throw new Error(result.message || result.error || 'Moodle API error');
  }

  return result;
}

function buildMoodleDownloadUrl(fileurl, token) {
  const url = new URL(fileurl);
  url.searchParams.set('token', token);
  url.searchParams.set('forcedownload', '1');
  return url.toString();
}

function guessMimeType(filename) {
  if (!filename) return 'application/octet-stream';
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

async function handleMoodleCourses(request, env) {
  try {
    const baseUrl = (env.MOODLE_BASE_URL || 'https://moodle.gpa-buddy.com').replace(/\/$/, '');
    const token = env.MOODLE_API_TOKEN || '2b3adf96137807ab66c5cffe4041f024';
    const endpoint = `${baseUrl}/webservice/rest/server.php`;

    const params = new URLSearchParams();
    params.append('wstoken', token);
    params.append('wsfunction', 'core_course_get_courses');
    params.append('moodlewsrestformat', 'json');

    console.log('[Moodle] fetching courses from:', endpoint);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GPA-Buddy-Worker/1.0',
      },
      body: params.toString(),
    });

    const responseText = await response.text();
    console.log('[Moodle] response status:', response.status);
    console.log('[Moodle] response body preview:', responseText.slice(0, 500));

    if (!response.ok) {
      throw new Error(`Moodle API HTTP error: ${response.status}, body: ${responseText.slice(0, 200)}`);
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Moodle API returned non-JSON (check Moodle wwwroot config): ${responseText.slice(0, 200)}`);
    }

    if (result && typeof result === 'object' && (result.exception || result.error)) {
      throw new Error(result.message || result.error || 'Moodle API error');
    }

    if (!Array.isArray(result)) {
      throw new Error('Unexpected Moodle API response');
    }

    const courses = result.filter(course => course.id !== 1).map(course => ({
      id: course.id,
      fullname: course.fullname,
      shortname: course.shortname,
      categoryid: course.categoryid,
    }));

    return createResponse(JSON.stringify({ courses }), 200, request);
  } catch (err) {
    console.error('[Moodle] failed to fetch courses:', err.message);
    return createResponse(JSON.stringify({ error: err.message }), 500, request);
  }
}

async function handleImportMoodleCourse(request, env, courseId) {
  try {
    const user = await getUserFromRequest(request, env);
    if (!user) return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401, request);

    const baseUrl = (env.MOODLE_BASE_URL || 'https://moodle.gpa-buddy.com').replace(/\/$/, '');
    const token = env.MOODLE_API_TOKEN || '2b3adf96137807ab66c5cffe4041f024';

    // 1. 获取 Moodle 课程基本信息
    const allCourses = await fetchMoodle('core_course_get_courses', { 'options[ids][0]': courseId }, baseUrl, token);
    if (!Array.isArray(allCourses)) {
      throw new Error('Unexpected Moodle course response');
    }
    const moodleCourse = allCourses.find(c => c.id == courseId);
    if (!moodleCourse) {
      throw new Error('Course not found in Moodle');
    }

    // 2. 在用户数据库中创建课程
    const courseResult = await env.DB.prepare(
      'INSERT INTO courses (user_id, name) VALUES (?, ?)'
    ).bind(user.id, moodleCourse.fullname).run();
    const newCourseId = courseResult.meta.last_row_id;

    // 3. 获取课程内容
    const contents = await fetchMoodle('core_course_get_contents', { courseid: courseId }, baseUrl, token);
    if (!Array.isArray(contents)) {
      throw new Error('Failed to get course contents from Moodle');
    }

    // 4. 收集文件资源
    const files = [];
    for (const section of contents) {
      for (const module of section.modules || []) {
        if (module.modname !== 'resource') continue;
        for (const content of module.contents || []) {
          if (content.type === 'file' && content.fileurl) {
            files.push({
              name: content.filename,
              url: content.fileurl,
              size: content.filesize || 0,
              type: guessMimeType(content.filename),
            });
          }
        }
      }
    }

    // 5. 下载并迁移到 R2
    const importedMaterials = [];
    for (const file of files) {
      try {
        const downloadUrl = buildMoodleDownloadUrl(file.url, token);
        const fileResponse = await fetch(downloadUrl);
        if (!fileResponse.ok) {
          console.error(`[Moodle Import] failed to download ${file.name}: ${fileResponse.status}`);
          continue;
        }
        const fileBlob = await fileResponse.blob();

        // 插入 materials 记录
        const insertResult = await env.DB.prepare(
          'INSERT INTO course_materials (course_id, name, size, type, content_text, r2_key) VALUES (?, ?, ?, ?, ?, ?)'
        ).bind(newCourseId, file.name, file.size, file.type, '', '').run();
        const materialId = insertResult.meta.last_row_id;

        // 上传到 R2
        const r2Key = buildMaterialR2Key(newCourseId, materialId, file.name);
        await uploadToR2(fileBlob, r2Key, env);

        // 更新 r2_key
        await env.DB.prepare('UPDATE course_materials SET r2_key = ? WHERE id = ?').bind(r2Key, materialId).run();

        importedMaterials.push({ id: materialId, name: file.name, size: file.size });
      } catch (err) {
        console.error(`[Moodle Import] error processing ${file.name}:`, err.message);
      }
    }

    // 6. 更新课程时间戳
    await env.DB.prepare('UPDATE courses SET updated_at = datetime("now") WHERE id = ?').bind(newCourseId).run();

    return createResponse(JSON.stringify({
      success: true,
      course: { id: newCourseId, name: moodleCourse.fullname },
      materials: importedMaterials,
    }), 200, request);
  } catch (err) {
    console.error('[Moodle Import] error:', err.message);
    return createResponse(JSON.stringify({ error: err.message }), 500, request);
  }
}

/* ==================== MAIN ==================== */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return handleOptions(request);

    const url = new URL(request.url);

    /* ===== AUTH ROUTES ===== */
    if (url.pathname === '/auth/google') {
      return handleGoogleLogin(request, env);
    }
    
    if (url.pathname === '/auth/google/callback') {
      return handleGoogleCallback(request, env);
    }
    
    if (url.pathname === '/auth/google/exchange' && request.method === 'POST') {
      return handleGoogleExchange(request, env);
    }
    
    if (url.pathname === '/auth/me' && request.method === 'GET') {
      return handleGetMe(request, env);
    }
    
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env);
    }
    
    if (url.pathname === '/auth/email/send-code' && request.method === 'POST') {
      return handleEmailSendCode(request, env);
    }
    
    if (url.pathname === '/auth/email/verify' && request.method === 'POST') {
      return handleEmailVerify(request, env);
    }

    /* ===== VISITOR ROUTES ===== */
    if (url.pathname === '/api/visitor/init' && request.method === 'POST') {
      return handleVisitorInit(request, env);
    }
    if (url.pathname === '/api/visitor/balance' && request.method === 'GET') {
      return handleVisitorBalance(request, env);
    }
    if (url.pathname === '/api/visitor/addcredit' && request.method === 'GET') {
      return handleVisitorAddCredit(request, env);
    }

    /* ===== BALANCE ROUTES ===== */
    if (url.pathname === '/api/balance' && request.method === 'GET') {
      return handleGetBalance(request, env);
    }
    if (url.pathname === '/api/claim-daily' && request.method === 'POST') {
      return handleClaimDaily(request, env);
    }
    if (url.pathname === '/api/redeem-voucher' && request.method === 'POST') {
      return handleRedeemVoucher(request, env);
    }

    /* ===== QUESTION BANK ROUTES ===== */
    if (url.pathname === '/api/banks' && request.method === 'GET') {
      return handleGetBanks(request, env);
    }
    
    if (url.pathname === '/api/banks' && request.method === 'POST') {
      return handleCreateBank(request, env);
    }
    
    const bankMatch = url.pathname.match(/^\/api\/banks\/(\d+)$/);
    if (bankMatch && request.method === 'GET') {
      return handleGetBank(request, env, bankMatch[1]);
    }
    if (bankMatch && request.method === 'DELETE') {
      return handleDeleteBank(request, env, bankMatch[1]);
    }
    
    const questionsMatch = url.pathname.match(/^\/api\/banks\/(\d+)\/questions$/);
    if (questionsMatch && request.method === 'POST') {
      return handleSaveQuestions(request, env, questionsMatch[1]);
    }

    /* ===== MOODLE ROUTES ===== */
    if (url.pathname === '/api/moodle/courses' && request.method === 'GET') {
      return handleMoodleCourses(request, env);
    }

    const moodleImportMatch = url.pathname.match(/^\/api\/moodle\/courses\/(\d+)\/import$/);
    if (moodleImportMatch && request.method === 'POST') {
      return handleImportMoodleCourse(request, env, moodleImportMatch[1]);
    }

    /* ===== COURSE ROUTES ===== */
    if (url.pathname === '/api/courses' && request.method === 'GET') {
      return handleGetCourses(request, env);
    }
    if (url.pathname === '/api/courses' && request.method === 'POST') {
      return handleCreateCourse(request, env);
    }

    const courseMatch = url.pathname.match(/^\/api\/courses\/(\d+)$/);
    if (courseMatch && request.method === 'GET') {
      return handleGetCourse(request, env, courseMatch[1]);
    }
    if (courseMatch && request.method === 'DELETE') {
      return handleDeleteCourse(request, env, courseMatch[1]);
    }

    const courseMaterialsMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/materials$/);
    if (courseMaterialsMatch && request.method === 'POST') {
      return handleUploadCourseMaterial(request, env, courseMaterialsMatch[1]);
    }

    const courseMaterialDeleteMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/materials\/(\d+)$/);
    if (courseMaterialDeleteMatch && request.method === 'DELETE') {
      return handleDeleteCourseMaterial(request, env, courseMaterialDeleteMatch[1], courseMaterialDeleteMatch[2]);
    }

    const courseMaterialDownloadMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/materials\/(\d+)\/download$/);
    if (courseMaterialDownloadMatch && request.method === 'GET') {
      return handleDownloadCourseMaterial(request, env, courseMaterialDownloadMatch[1], courseMaterialDownloadMatch[2]);
    }

    const courseAnalyzeMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/analyze$/);
    if (courseAnalyzeMatch && request.method === 'POST') {
      return handleAnalyzeCourse(request, env, ctx, courseAnalyzeMatch[1]);
    }

    const courseGenerateBanksMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/generate-banks$/);
    if (courseGenerateBanksMatch && request.method === 'POST') {
      return handleGenerateCourseBanks(request, env, ctx, courseGenerateBanksMatch[1]);
    }

    const courseQuestionsMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/questions$/);
    if (courseQuestionsMatch && request.method === 'POST') {
      return handleSaveCourseQuestions(request, env, courseQuestionsMatch[1]);
    }

    const courseQuestionDeleteMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/questions\/(\d+)$/);
    if (courseQuestionDeleteMatch && request.method === 'DELETE') {
      return handleDeleteCourseQuestion(request, env, courseQuestionDeleteMatch[1], courseQuestionDeleteMatch[2]);
    }

    const courseBatchRenameMatch = url.pathname.match(/^\/api\/courses\/(\d+)\/batches\/(\d+)$/);
    if (courseBatchRenameMatch && request.method === 'PUT') {
      return handleRenameCourseBatch(request, env, courseBatchRenameMatch[1], courseBatchRenameMatch[2]);
    }

    /* ===== CLOUD BANK ROUTES ===== */
    if (url.pathname === '/api/cloud-banks' && request.method === 'POST') {
      return handleUploadCloudBank(request, env);
    }
    if (url.pathname === '/api/cloud-banks' && request.method === 'GET') {
      return handleGetCloudBanks(request, env);
    }
    
    const cloudBankMatch = url.pathname.match(/^\/api\/cloud-banks\/(\d+)$/);
    if (cloudBankMatch && request.method === 'DELETE') {
      return handleDeleteCloudBank(request, env, cloudBankMatch[1]);
    }

    const cloudBankSourceMatch = url.pathname.match(/^\/api\/cloud-banks\/(\d+)\/source-file$/);
    if (cloudBankSourceMatch && request.method === 'GET') {
      return handleDownloadCloudBankSourceFile(request, env, cloudBankSourceMatch[1]);
    }

    const cloudBankSourceUpdateMatch = url.pathname.match(/^\/api\/cloud-banks\/(\d+)\/source$/);
    if (cloudBankSourceUpdateMatch && request.method === 'POST') {
      return handleUpdateCloudBankSource(request, env, cloudBankSourceUpdateMatch[1]);
    }
    
    /* ===== SHARE ROUTES ===== */
    const shareMatch = url.pathname.match(/^\/api\/share\/(\d+)$/);
    if (shareMatch && request.method === 'GET') {
      return handleGetShareBank(request, env, shareMatch[1]);
    }
    
    const shareDownloadMatch = url.pathname.match(/^\/api\/share\/(\d+)\/download$/);
    if (shareDownloadMatch && request.method === 'POST') {
      return handleDownloadShareBank(request, env, shareDownloadMatch[1]);
    }

    /* ===== CHAT (DeepSeek) [DISABLED] ===== */
    if (false && url.pathname === '/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        
        if (!body.messages || !Array.isArray(body.messages)) {
          return createResponse(JSON.stringify({ error: 'messages field is required' }), 400);
        }
        if (body.messages.length > 50) {
          return createResponse(JSON.stringify({ error: 'Too many messages (max 50)' }), 400);
        }
        const totalContentLength = body.messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        if (totalContentLength > 50000) {
          return createResponse(JSON.stringify({ error: 'Total content too long (max 50KB)' }), 400);
        }

        const visitorId = request.headers.get('X-Visitor-ID');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'chat');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const result = await callDeepSeekWithRetry(body.messages, env.DEEPSEEK_API_KEY);
        return createResponse(JSON.stringify(result));
      } catch (error) {
        console.error('[DEBUG] /chat error:', error);
        return createResponse(JSON.stringify({ error: error.message }), 500);
      }
    }

    /* ===== CHAT BATCH [DISABLED] ===== */
    if (false && url.pathname === '/chat/batch' && request.method === 'POST') {
      console.log('[DEBUG] /chat/batch endpoint called');
      
      try {
        const body = await request.json();
        
        const visitorId = request.headers.get('X-Visitor-ID');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'chat_batch');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        if (!body.items || !Array.isArray(body.items)) {
          console.error('[DEBUG] Error: items field is required');
          return createResponse(JSON.stringify({ error: 'items field is required' }), 400);
        }
        if (body.items.length > 20) {
          return createResponse(JSON.stringify({ error: 'Too many items (max 20)' }), 400);
        }
        const totalContentLength = body.items.reduce((sum, item) => {
          return sum + (item.messages?.reduce((s, m) => s + (m.content?.length || 0), 0) || 0);
        }, 0);
        if (totalContentLength > 100000) {
          return createResponse(JSON.stringify({ error: 'Total content too long (max 100KB)' }), 400);
        }
        
        console.log(`[DEBUG] Received ${body.items.length} items for batch processing`);

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const promises = body.items.map(async (item) => {
          console.log(`[DEBUG] Processing chunk_id=${item.chunk_id}`);
          try {
            const result = await callDeepSeekWithRetry(item.messages, env.DEEPSEEK_API_KEY);
            console.log(`[DEBUG] chunk_id=${item.chunk_id} succeeded`);
            return {
              chunk_id: item.chunk_id,
              success: true,
              data: result,
            };
          } catch (error) {
            console.error(`[DEBUG] chunk_id=${item.chunk_id} failed:`, error.message);
            return {
              chunk_id: item.chunk_id,
              success: false,
              error: error.message,
            };
          }
        });

        const results = await Promise.all(promises);
        const failed = results.filter(r => !r.success);
        
        console.log(`[DEBUG] Batch processing complete: total=${results.length}, successful=${results.length - failed.length}, failed=${failed.length}`);

        return createResponse(JSON.stringify({
          total: results.length,
          successful: results.filter(r => r.success).length,
          failed: failed.length,
          results: results,
        }));
      } catch (error) {
        console.error('[DEBUG] /chat/batch error:', error);
        return createResponse(JSON.stringify({ error: error.message }), 500);
      }
    }

    /* ===== STATS ===== */
    if (url.pathname === '/stats') {
      const count = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
      return createResponse(JSON.stringify({ total: count }));
    }

    /* ===== UPLOAD ===== */
    if (url.pathname === '/upload') {
      try {
        const turnstileToken = url.searchParams.get('turnstileToken');

        // Turnstile 人机验证
        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        const form = await request.formData();
        const file = form.get('file');

        if (!file) {
          return createResponse(JSON.stringify({ error: 'No file received' }), 400);
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const token = await getAccessToken(env);
        const name = `${Date.now()}_${file.name}`;
        const buffer = await file.arrayBuffer();
        const uri = await uploadToGCS(buffer, name, token, env);

        return createResponse(JSON.stringify({
          fileUri: uri,
          fileName: name,
        }));

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== GENERATE [DISABLED] ===== */
    if (false && url.pathname === '/generate') {
      try {
        const { fileUris, prompt } = await request.json();
        const fileUri = fileUris[0];

        const visitorId = request.headers.get('X-Visitor-ID');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'generate');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const token = await getAccessToken(env);
        const vertexRes = await streamVertex(fileUri, prompt, env, token);

        if (!vertexRes.ok) {
          const errText = await vertexRes.text();
          return new Response(
            JSON.stringify({ error: errText }),
            { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        ctx.waitUntil((async () => {
          const reader = vertexRes.body.getReader();
          const decoder = new TextDecoder();
          let rawBuffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              rawBuffer += chunk;

              const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
              let match;
              while ((match = textRegex.exec(rawBuffer)) !== null) {
                try {
                  const text = JSON.parse(`"${match[1]}"`);
                  if (text) {
                    await sendSSE({ type: 'chunk', data: text });
                  }
                } catch (e) {
                }
              }
              
              let lastIndex = 0;
              const allMatches = [...rawBuffer.matchAll(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g)];
              if (allMatches.length > 0) {
                const last = allMatches[allMatches.length - 1];
                lastIndex = last.index + last[0].length;
              }
              rawBuffer = rawBuffer.slice(lastIndex);
            }

            await sendSSE({ type: 'done' });
          } catch (err) {
            await sendSSE({ type: 'error', message: err.message });
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });
        
      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== GENERATE FROM TEXT [DISABLED] ===== */
    if (false && url.pathname === '/generate/text' && request.method === 'POST') {
      try {
        const { text, prompt, batchIndex, totalBatches } = await request.json();
        
        if (!text || !prompt) {
          return createResponse(JSON.stringify({ error: 'text and prompt are required' }), 400);
        }

        const visitorId = request.headers.get('X-Visitor-ID');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'generate_text');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const token = await getAccessToken(env);
        const vertexRes = await streamVertexFromText(text, prompt, env, token);

        if (!vertexRes.ok) {
          const errText = await vertexRes.text();
          return new Response(
            JSON.stringify({ error: errText }),
            { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        ctx.waitUntil((async () => {
          const reader = vertexRes.body.getReader();
          const decoder = new TextDecoder();
          let rawBuffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              const chunk = decoder.decode(value, { stream: true });
              rawBuffer += chunk;

              const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
              let match;
              while ((match = textRegex.exec(rawBuffer)) !== null) {
                try {
                  const text = JSON.parse(`"${match[1]}"`);
                  if (text) {
                    await sendSSE({ type: 'chunk', data: text });
                  }
                } catch (e) {
                }
              }
              
              let lastIndex = 0;
              const allMatches = [...rawBuffer.matchAll(/"text"\s*:\s*"(?:[^"\\]|\\.)*"/g)];
              if (allMatches.length > 0) {
                const last = allMatches[allMatches.length - 1];
                lastIndex = last.index + last[0].length;
              }
              rawBuffer = rawBuffer.slice(lastIndex);
            }

            await sendSSE({ type: 'done' });
          } catch (err) {
            await sendSSE({ type: 'error', message: err.message });
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });
        
      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== TEXT GENERATE (All-in-one) ===== */
    if (url.pathname === '/text_generate' && request.method === 'POST') {
      try {
        // 1. 解析 form-data
        const form = await request.formData();
        const text = form.get('text');
        const questionCount = parseInt(form.get('questionCount')) || 20;
        const lang = form.get('lang') || 'zh';
        const turnstileToken = form.get('turnstileToken');
        const fileName = form.get('fileName') || 'document';
        const fileType = form.get('fileType') || 'txt';
        const courseId = form.get('courseId');

        // 如果请求指定了 courseId，校验课程归属
        let validatedCourseId = null;
        if (courseId) {
          const user = await getUserFromRequest(request, env);
          if (!user) {
            return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
          }
          const course = await env.DB.prepare(
            'SELECT id FROM courses WHERE id = ? AND user_id = ?'
          ).bind(courseId, user.id).first();
          if (!course) {
            return createResponse(JSON.stringify({ error: 'Course not found' }), 404);
          }
          validatedCourseId = courseId;
        }

        if (!text || text.trim().length === 0) {
          return createResponse(JSON.stringify({ error: 'No text provided' }), 400);
        }
        if (text.length > 500000) {
          return createResponse(JSON.stringify({ error: 'Text too long (max 500KB)' }), 400);
        }
        if (questionCount > 200 || questionCount < 1) {
          return createResponse(JSON.stringify({ error: 'Invalid question count (1-200)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }

        // 2. Turnstile 人机验证
        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        // Visitor credits check
        const visitorId = form.get('visitorId');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'text_generate');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 3. 创建 SSE 流
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        // 4. 异步执行生成逻辑
        ctx.waitUntil((async () => {
          try {
            const { questions: allResults } = await generateQuestionsFromText(
              text,
              { questionCount, lang, fileName, fileType },
              env,
              sendSSE
            );

            // 如果关联了课程，保存生成的题目到课程（建批次，名称为文件名）
            if (validatedCourseId) {
              try {
                const batchResult = await env.DB.prepare(
                  'INSERT INTO course_question_batches (course_id, name) VALUES (?, ?)'
                ).bind(validatedCourseId, (fileName || 'document').slice(0, 200)).run();
                await saveGeneratedQuestionsToCourse(env, validatedCourseId, allResults, null, batchResult.meta.last_row_id);
                console.log(`[DEBUG] Saved ${allResults.length} questions to course ${validatedCourseId}`);
              } catch (saveErr) {
                console.error('[DEBUG] Failed to save generated questions to course:', saveErr);
              }
            }

          } catch (err) {
            console.error('[DEBUG] Text Generate error:', err);
            await sendSSE({ type: 'error', message: err.message });
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== CLEANUP ===== */
    if (url.pathname === '/cleanup') {
      try {
        const { fileUri } = await request.json();
        if (!fileUri) {
          return createResponse(JSON.stringify({ error: 'fileUri is required' }), 400);
        }
        
        const fileName = fileUri.split('/').pop();
        const token = await getAccessToken(env);
        await deleteFromGCS(fileName, token, env);
        
        return createResponse(JSON.stringify({ 
          success: true, 
          message: 'File cleaned up successfully' 
        }));
        
      } catch (err) {
        return createResponse(JSON.stringify({ 
          error: err.message 
        }), 500);
      }
    }

    /* ===== ORGANIZE (All-in-one: count + organize) ===== */
    if (url.pathname === '/organize' && request.method === 'POST') {
      try {
        // 1. 解析 form-data
        const form = await request.formData();
        const text = form.get('text');
        const turnstileToken = form.get('turnstileToken');
        const lang = form.get('lang') || 'zh';

        if (!text || text.trim().length === 0) {
          return createResponse(JSON.stringify({ error: 'No text provided' }), 400);
        }
        if (text.length > 500000) {
          return createResponse(JSON.stringify({ error: 'Text too long (max 500KB)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }

        // 2. Turnstile 人机验证
        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        // Visitor credits check
        const visitorId = form.get('visitorId');
        if (visitorId) {
          const quota = await checkAndConsumeVisitorCredits(visitorId, request, env, 'organize');
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        console.log('[DEBUG] Starting organize process');

        // 3. 阶段1：识别题目数量
        const countPrompt = buildCountPrompt(text, lang);
        const countResult = await callDeepSeekWithRetry(
          [{ role: 'user', content: countPrompt }],
          env.DEEPSEEK_API_KEY
        );
        const countResponse = countResult.choices?.[0]?.message?.content || '';
        let questionCount = parseInt(countResponse.trim().match(/\d+/)?.[0] || '0');
        if (!questionCount || questionCount <= 0) {
          questionCount = 40; // 默认40题
        }
        console.log(`[DEBUG] Detected ${questionCount} questions`);

        // 4. 阶段2：分割文本并整理
        const numGroups = Math.ceil(questionCount / 20);
        const chunks = splitTextForOrganize(text, numGroups);
        console.log(`[DEBUG] Split into ${chunks.length} chunks`);

        // 并行处理所有 chunks
        const organizePromises = chunks.map((chunk, i) => {
          if (!chunk || chunk.trim().length === 0) {
            return Promise.resolve([]);
          }
          const startId = i * 20 + 1;
          const organizePrompt = buildOrganizePrompt(chunk, startId, i, numGroups, lang);
          
          return callDeepSeekWithRetry(
            [{ role: 'user', content: organizePrompt }],
            env.DEEPSEEK_API_KEY
          )
            .then(result => {
              const fullResponse = result.choices?.[0]?.message?.content || '';
              const questions = extractJSONFromText(fullResponse);
              
              if (Array.isArray(questions)) {
                questions.forEach((q, idx) => {
                  q.id = startId + idx;
                  q.source = '用户上传题库';
                });
              }
              return questions || [];
            })
            .catch(err => {
              console.error(`[DEBUG] Chunk ${i+1} failed:`, err);
              return [];
            });
        });

        const allQuestionsArrays = await Promise.all(organizePromises);
        const allQuestions = allQuestionsArrays.flat();
        
        console.log(`[DEBUG] Organize complete: ${allQuestions.length} questions`);

        return createResponse(JSON.stringify({
          success: true,
          detectedCount: questionCount,
          questions: allQuestions
        }));

      } catch (err) {
        console.error('[DEBUG] Organize error:', err);
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== TUTOR GENERATE ===== */
    if (url.pathname === '/api/tutor/generate' && request.method === 'POST') {
      try {
        // 1. 解析 form-data
        const form = await request.formData();
        const file = form.get('file');
        const lang = form.get('lang') || 'zh';
        const mode = form.get('mode') || 'expert';
        const customPrompt = form.get('customPrompt') || '';
        const turnstileToken = form.get('turnstileToken');

        // 输入校验
        if (customPrompt.length > 2000) {
          return createResponse(JSON.stringify({ error: 'Custom prompt too long (max 2000 chars)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }
        if (!['fast', 'expert'].includes(mode)) {
          return createResponse(JSON.stringify({ error: 'Invalid mode' }), 400);
        }

        if (!file) {
          return createResponse(JSON.stringify({ error: 'No file received' }), 400);
        }

        // 2. Turnstile 人机验证
        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        // Visitor credits check (fast/expert = 5 credits) - 先检查不扣费，生成结束后再扣
        const visitorId = form.get('visitorId');
        const tutorCost = 5;
        if (visitorId) {
          const quota = await peekVisitorCredits(visitorId, request, env, tutorCost);
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 3. 上传到 GCS
        const token = await getAccessToken(env);
        const name = `${Date.now()}_${file.name}`;
        const buffer = await file.arrayBuffer();
        const fileUri = await uploadToGCS(buffer, name, token, env);

        // 4. 创建 SSE 流
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        // 5. 异步执行生成逻辑
        ctx.waitUntil((async () => {
          try {
            // 5.1 骨架生成
            const modelId = mode === 'fast' ? 'gemini-2.5-flash-lite' : 'gemini-2.5-pro';
            const skeletonPrompt = buildTutorSkeletonPrompt(lang, customPrompt);
            const tutorThinkingConfig = { thinkingBudget:-1 };
            const skeletonRes = await streamVertex(fileUri, skeletonPrompt, env, token, modelId, tutorThinkingConfig);
            if (!skeletonRes.ok) {
              const errText = await skeletonRes.text();
              throw new Error(`VERTEX_ERROR|Skeleton generation failed: ${errText}`);
            }
            const skeletonText = await streamVertexToText(skeletonRes);
            const skeleton = safeParseJSON(skeletonText);
            if (!skeleton || !Array.isArray(skeleton.nodes) || !Array.isArray(skeleton.edges)) {
              throw new Error('Invalid skeleton JSON from AI');
            }
            sanitizeSkeleton(skeleton);
            await sendSSE({ type: 'skeleton_done', data: skeleton });

            // 5.2 构建拓扑依赖（仅 hard 边参与调度，soft 边不阻塞）
            const hardEdges = skeleton.edges.filter(e => e.type === 'hard');
            const nodeMap = new Map(skeleton.nodes.map(n => [n.id, n]));

            // parentMap: nodeId -> [parentIds] (仅 hard 边)
            // childrenMap: nodeId -> [childIds] (仅 hard 边)
            const parentMap = new Map();
            const childrenMap = new Map();
            const inDegree = new Map();

            skeleton.nodes.forEach(n => {
              parentMap.set(n.id, []);
              childrenMap.set(n.id, []);
              inDegree.set(n.id, 0);
            });

            hardEdges.forEach(e => {
              if (nodeMap.has(e.from) && nodeMap.has(e.to)) {
                parentMap.get(e.to).push(e.from);
                childrenMap.get(e.from).push(e.to);
                inDegree.set(e.to, inDegree.get(e.to) + 1);
              }
            });

            // 5.3 辅助：单个节点生成（含重试和兜底）
            async function generateSingleNode(node, parentHooks) {
              await sendSSE({ type: 'node_start', nodeId: node.id, name: node.name });

              let nodeContent = null;
              const nodePrompt = buildTutorNodePrompt(node, parentHooks, lang);
              const nodeRes = await streamVertex(fileUri, nodePrompt, env, token, modelId, tutorThinkingConfig);
              if (!nodeRes.ok) {
                console.error(`Node ${node.id} failed:`, await nodeRes.text());
              } else {
                const nodeText = await streamVertexToText(nodeRes);
                nodeContent = safeParseJSON(nodeText);
              }

              // 如果失败或解析为空，使用简化 prompt 重试一次
              if (!nodeContent || !nodeContent.coreConcepts || nodeContent.coreConcepts.length === 0) {
                console.warn(`Node ${node.id} empty or parse failed, retrying with concise prompt...`);
                const retryPrompt = buildTutorNodePromptRetry(node, lang);
                const retryRes = await streamVertex(fileUri, retryPrompt, env, token, modelId, tutorThinkingConfig);
                if (retryRes.ok) {
                  const retryText = await streamVertexToText(retryRes);
                  const retryContent = safeParseJSON(retryText);
                  if (retryContent && retryContent.coreConcepts && retryContent.coreConcepts.length > 0) {
                    nodeContent = retryContent;
                  }
                }
              }

              // 最终兜底
              if (!nodeContent || !nodeContent.coreConcepts || nodeContent.coreConcepts.length === 0) {
                nodeContent = {
                  nodeId: node.id,
                  introQuestion: `What is ${node.name}?`,
                  coreConcepts: [
                    { title: node.name, content: 'Content generation failed. Please try regenerating the graph.', source: '' }
                  ],
                  checkActivities: [],
                  exitHook: node.name
                };
              }

              await sendSSE({ type: 'node_done', nodeId: node.id, data: nodeContent });
              return nodeContent;
            }

            // 5.4 依赖感知批处理生成节点内容
            const BATCH_SIZE = 5;
            const contentMap = new Map(); // nodeId -> generated content
            let processedCount = 0;

            while (true) {
              const batch = selectBatchNodes(skeleton.nodes, inDegree, parentMap, contentMap, BATCH_SIZE);
              if (batch.length === 0) break;

              const processedInBatch = new Set();
              let batchResult = null;

              // 尝试激进批量生成（允许批次内存在依赖关系）
              try {
                const batchPrompt = buildTutorDependencyBatchPrompt(batch, parentMap, contentMap, lang);
                const batchRes = await streamVertex(fileUri, batchPrompt, env, token, modelId, tutorThinkingConfig);
                if (batchRes.ok) {
                  const batchText = await streamVertexToText(batchRes);
                  batchResult = safeParseJSON(batchText);
                }
              } catch (batchErr) {
                console.error('Aggressive batch generation error:', batchErr);
              }

              // 处理批量结果中的节点
              if (batchResult) {
                for (const node of batch) {
                  if (batchResult[node.id] && batchResult[node.id].coreConcepts && batchResult[node.id].coreConcepts.length > 0) {
                    await sendSSE({ type: 'node_start', nodeId: node.id, name: node.name });
                    await sendSSE({ type: 'node_done', nodeId: node.id, data: batchResult[node.id] });
                    contentMap.set(node.id, batchResult[node.id]);
                    processedInBatch.add(node.id);
                    processedCount++;
                  }
                }
              }

              // Fallback: 对失败的节点，只处理当前入度为0的（保守模式）
              const failedNodes = batch.filter(n => !processedInBatch.has(n.id));
              for (const node of failedNodes) {
                if (inDegree.get(node.id) === 0) {
                  const parentHooks = (parentMap.get(node.id) || [])
                    .map(pid => contentMap.get(pid)?.exitHook)
                    .filter(Boolean);
                  const nodeContent = await generateSingleNode(node, parentHooks);
                  contentMap.set(node.id, nodeContent);
                  processedInBatch.add(node.id);
                  processedCount++;
                }
              }

              // 更新所有已处理节点的后继入度
              for (const nodeId of processedInBatch) {
                for (const childId of childrenMap.get(nodeId) || []) {
                  inDegree.set(childId, inDegree.get(childId) - 1);
                }
              }
            }

            // 处理未被拓扑覆盖的孤立节点（如有）
            const remainingNodes = skeleton.nodes.filter(n => !contentMap.has(n.id));
            for (const node of remainingNodes) {
              const parentHooks = (parentMap.get(node.id) || [])
                .map(pid => contentMap.get(pid)?.exitHook)
                .filter(Boolean);
              const nodeContent = await generateSingleNode(node, parentHooks);
              contentMap.set(node.id, nodeContent);
            }

            // 生成成功后再扣费
            if (visitorId) {
              const deducted = await deductVisitorCredits(visitorId, request, env, 'tutor_generate', tutorCost);
              if (!deducted) {
                console.warn('[Tutor Generate] Deduction failed after generation');
              }
            }

            await sendSSE({ type: 'complete' });

          } catch (err) {
            console.error('Tutor generate error:', err);
            const isVertexErr = err.message?.startsWith('VERTEX_ERROR|');
            const source = isVertexErr ? 'vertex' : 'worker';
            const cleanMessage = isVertexErr ? err.message.slice('VERTEX_ERROR|'.length) : err.message;
            await sendSSE({ type: 'error', source, message: cleanMessage });
          } finally {
            // 清理 GCS 文件
            try {
              await deleteFromGCS(name, token, env);
            } catch (cleanupErr) {
              console.error('Cleanup error:', cleanupErr);
            }
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== PDF GENERATE (All-in-one) ===== */
    if (url.pathname === '/pdf_generate' && request.method === 'POST') {
      try {
        // 1. 解析 form-data
        const form = await request.formData();
        const file = form.get('file');
        const questionCount = parseInt(form.get('questionCount')) || 20;
        const lang = form.get('lang') || 'zh';
        const turnstileToken = form.get('turnstileToken');
        const pageCount = parseInt(form.get('pageCount')) || 0;
        const originalFileName = form.get('originalFileName') || 'document';
        const customPrompt = form.get('customPrompt') || '';
        const courseId = form.get('courseId');

        // 如果请求指定了 courseId，校验课程归属
        let validatedCourseId = null;
        if (courseId) {
          const user = await getUserFromRequest(request, env);
          if (!user) {
            return createResponse(JSON.stringify({ error: 'Unauthorized' }), 401);
          }
          const course = await env.DB.prepare(
            'SELECT id FROM courses WHERE id = ? AND user_id = ?'
          ).bind(courseId, user.id).first();
          if (!course) {
            return createResponse(JSON.stringify({ error: 'Course not found' }), 404);
          }
          validatedCourseId = courseId;
        }

        // 输入校验
        if (questionCount > 200 || questionCount < 1) {
          return createResponse(JSON.stringify({ error: 'Invalid question count (1-200)' }), 400);
        }
        if (customPrompt.length > 2000) {
          return createResponse(JSON.stringify({ error: 'Custom prompt too long (max 2000 chars)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }

        if (!file) {
          return createResponse(JSON.stringify({ error: 'No file received' }), 400);
        }

        // 2. Turnstile 人机验证
        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        // Visitor credits check (peek only, deduct after generation)
        const visitorId = form.get('visitorId');
        if (visitorId) {
          const quota = await peekVisitorCredits(visitorId, request, env);
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        // 增加统计计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 3. 上传到 GCS
        const token = await getAccessToken(env);
        const name = `${Date.now()}_${file.name}`;
        const buffer = await file.arrayBuffer();
        const fileUri = await uploadToGCS(buffer, name, token, env);

        // 4. 计算批次
        const totalBatches = Math.ceil(questionCount / 20);

        // 5. 创建 SSE 流
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        // 6. 异步执行生成逻辑
        ctx.waitUntil((async () => {
          try {
            const allResults = [];
            let totalTokenCount = 0;

            // 6.1 执行 batch0 并流式返回
            const batch0Prompt = buildBatchPrompt(0, totalBatches, lang, originalFileName, pageCount, customPrompt);
            const vertexRes0 = await streamVertex(fileUri, batch0Prompt, env, token);

            if (!vertexRes0.ok) {
              const errText = await vertexRes0.text();
              throw new Error(`VERTEX_ERROR|Batch 0 failed: ${errText}`);
            }

            // 流式读取 batch0 并转发给前端
            const batch0Result = await streamBatchToClient(vertexRes0, sendSSE, 'batch0');
            allResults.push(...batch0Result.questions);
            totalTokenCount += batch0Result.totalTokenCount || 0;
            await sendSSE({ type: 'batch0_done', count: batch0Result.questions.length });

            // 6.2 并行执行其他批次
            if (totalBatches > 1) {
              const otherBatchPromises = [];
              for (let i = 1; i < totalBatches; i++) {
                const prompt = buildBatchPrompt(i, totalBatches, lang, originalFileName, pageCount, customPrompt);
                otherBatchPromises.push(
                  streamVertex(fileUri, prompt, env, token)
                    .then(res => parseBatchResponse(res))
                    .catch(err => {
                      console.error(`Batch ${i} failed:`, err);
                      return { questions: [], totalTokenCount: 0 }; // 失败返回空结果
                    })
                );
              }

              const otherResults = await Promise.all(otherBatchPromises);
              otherResults.forEach(result => {
                allResults.push(...result.questions);
                totalTokenCount += result.totalTokenCount || 0;
              });
            }

            // 6.3 重新编号并返回最终结果
            allResults.forEach((q, idx) => { q.id = idx + 1; });
            const generatedCount = allResults.length;
            const threshold = Math.ceil(questionCount * 0.95);
            const partial = generatedCount < threshold;
            
            // 数量足够才扣费，否则不扣
            if (!partial && visitorId) {
              const deducted = await deductVisitorCredits(visitorId, request, env, 'pdf_generate');
              if (!deducted) {
                console.warn('[PDF Generate] Deduction failed after generation, credits may have been consumed by concurrent requests');
              }
            }
            
            console.log(`[DEBUG] Final result: ${generatedCount} questions (requested ${questionCount}, threshold ${threshold}, partial=${partial})`);
            console.log(`[DEBUG] First question:`, allResults[0] ? allResults[0].question?.substring(0, 50) : 'N/A');
            console.log(`[DEBUG] Total token count: ${totalTokenCount}`);
            await sendSSE({ type: 'final_result', data: allResults, tokenCount: totalTokenCount, generatedCount, requestedCount: questionCount, partial });
            await sendSSE({ type: 'done' });

            // 如果关联了课程，保存生成的题目到课程（建批次，名称为 PDF 文件名）
            if (validatedCourseId) {
              try {
                const batchResult = await env.DB.prepare(
                  'INSERT INTO course_question_batches (course_id, name) VALUES (?, ?)'
                ).bind(validatedCourseId, (originalFileName || 'document').slice(0, 200)).run();
                await saveGeneratedQuestionsToCourse(env, validatedCourseId, allResults, null, batchResult.meta.last_row_id);
                console.log(`[DEBUG] Saved ${allResults.length} questions to course ${validatedCourseId}`);
              } catch (saveErr) {
                console.error('[DEBUG] Failed to save generated questions to course:', saveErr);
              }
            }

          } catch (err) {
            console.error('PDF Generate error:', err);
            const isVertexErr = err.message?.startsWith('VERTEX_ERROR|');
            const source = isVertexErr ? 'vertex' : 'worker';
            const cleanMessage = isVertexErr ? err.message.slice('VERTEX_ERROR|'.length) : err.message;
            await sendSSE({ type: 'error', source, message: cleanMessage });
          } finally {
            // 7. 清理 GCS 文件
            try {
              await deleteFromGCS(name, token, env);
            } catch (cleanupErr) {
              console.error('Cleanup error:', cleanupErr);
            }
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== FALLBACK PDF GENERATE (DeepSeek Text) ===== */
    if (url.pathname === '/fallback/pdf_generate' && request.method === 'POST') {
      try {
        const form = await request.formData();
        const text = form.get('text');
        const questionCount = parseInt(form.get('questionCount')) || 20;
        const lang = form.get('lang') || 'zh';
        const turnstileToken = form.get('turnstileToken');
        const originalFileName = form.get('originalFileName') || 'document';
        const customPrompt = form.get('customPrompt') || '';

        if (questionCount > 200 || questionCount < 1) {
          return createResponse(JSON.stringify({ error: 'Invalid question count (1-200)' }), 400);
        }
        if (customPrompt.length > 2000) {
          return createResponse(JSON.stringify({ error: 'Custom prompt too long (max 2000 chars)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }
        if (!text || typeof text !== 'string') {
          return createResponse(JSON.stringify({ error: 'Text content is required' }), 400);
        }

        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        const visitorId = form.get('visitorId');
        if (visitorId) {
          const quota = await peekVisitorCredits(visitorId, request, env);
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const totalBatches = Math.ceil(questionCount / 20);
        const chunks = splitTextByPageMarkers(text, totalBatches);

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        ctx.waitUntil((async () => {
          try {
            const allResults = [];

            const batch0Text = chunks[0] || '';
            const batch0Prompt = buildFallbackBatchPrompt(batch0Text, 0, totalBatches, lang, 1, originalFileName, customPrompt);
            const batch0Result = await streamDeepSeekJSONWithRetry(
              [{ role: 'user', content: batch0Prompt }],
              env.DEEPSEEK_API_KEY,
              2,
              (chunk) => sendSSE({ type: 'batch0_chunk', data: chunk })
            );
            const batch0Questions = Array.isArray(batch0Result) ? batch0Result : [];
            allResults.push(...batch0Questions);
            await sendSSE({ type: 'batch0_done', count: batch0Questions.length });

            if (totalBatches > 1) {
              const otherPromises = [];
              for (let i = 1; i < totalBatches; i++) {
                const chunkText = chunks[i] || '';
                const startId = i * 20 + 1;
                const prompt = buildFallbackBatchPrompt(chunkText, i, totalBatches, lang, startId, originalFileName, customPrompt);
                otherPromises.push(
                  streamDeepSeekJSONWithRetry([{ role: 'user', content: prompt }], env.DEEPSEEK_API_KEY)
                    .then(res => Array.isArray(res) ? res : [])
                    .catch(err => {
                      console.error(`[Fallback] Batch ${i} failed:`, err);
                      return [];
                    })
                );
              }
              const otherResults = await Promise.all(otherPromises);
              otherResults.forEach(arr => allResults.push(...arr));
            }

            allResults.forEach((q, idx) => { q.id = idx + 1; });
            const generatedCount = allResults.length;
            const threshold = Math.ceil(questionCount * 0.95);
            const partial = generatedCount < threshold;

            if (!partial && visitorId) {
              const deducted = await deductVisitorCredits(visitorId, request, env, 'pdf_generate');
              if (!deducted) {
                console.warn('[Fallback PDF Generate] Deduction failed after generation');
              }
            }

            await sendSSE({ type: 'final_result', data: allResults, tokenCount: 0, generatedCount, requestedCount: questionCount, partial });
            await sendSSE({ type: 'done' });

          } catch (err) {
            console.error('Fallback PDF Generate error:', err);
            await sendSSE({ type: 'error', source: 'worker', message: err.message });
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== FALLBACK TUTOR GENERATE (DeepSeek Text) ===== */
    if (url.pathname === '/fallback/tutor_generate' && request.method === 'POST') {
      try {
        const form = await request.formData();
        const text = form.get('text');
        const lang = form.get('lang') || 'zh';
        const customPrompt = form.get('customPrompt') || '';
        const turnstileToken = form.get('turnstileToken');

        if (customPrompt.length > 2000) {
          return createResponse(JSON.stringify({ error: 'Custom prompt too long (max 2000 chars)' }), 400);
        }
        if (!['zh', 'zh-TW', 'en', 'ko'].includes(lang)) {
          return createResponse(JSON.stringify({ error: 'Invalid language' }), 400);
        }
        if (!text || typeof text !== 'string') {
          return createResponse(JSON.stringify({ error: 'Text content is required' }), 400);
        }

        if (env.TURNSTILE_SECRET_KEY) {
          if (!turnstileToken) {
            return createResponse(JSON.stringify({ error: 'Turnstile token required' }), 403);
          }
          const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              secret: env.TURNSTILE_SECRET_KEY,
              response: turnstileToken,
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyData.success) {
            return createResponse(JSON.stringify({ error: 'Turnstile verification failed' }), 403);
          }
        }

        const visitorId = form.get('visitorId');
        const fallbackMode = form.get('mode') || 'text';
        const tutorCost = fallbackMode === 'text' ? 2 : 5;
        if (visitorId) {
          const quota = await peekVisitorCredits(visitorId, request, env, tutorCost);
          if (!quota.allowed) {
            return createResponse(JSON.stringify({ error: quota.reason || 'Insufficient credits' }), 402);
          }
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const sendSSE = async (obj) => {
          await writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        ctx.waitUntil((async () => {
          try {
            const skeletonPrompt = buildFallbackTutorSkeletonPrompt(text, lang, customPrompt);
            const skeletonResult = await streamDeepSeekJSONWithRetry([{ role: 'user', content: skeletonPrompt }], env.DEEPSEEK_API_KEY);
            const skeleton = skeletonResult;

            if (!skeleton || !Array.isArray(skeleton.nodes) || !Array.isArray(skeleton.edges)) {
              throw new Error('Invalid skeleton JSON from DeepSeek');
            }
            if (skeleton.nodes.length > 25) {
              skeleton.nodes = skeleton.nodes.slice(0, 25);
            }

            sanitizeSkeleton(skeleton);
            await sendSSE({ type: 'skeleton_done', data: skeleton });

            const hardEdges = skeleton.edges.filter(e => e.type === 'hard');
            const nodeMap = new Map(skeleton.nodes.map(n => [n.id, n]));

            const parentMap = new Map();
            const childrenMap = new Map();
            const inDegree = new Map();

            skeleton.nodes.forEach(n => {
              parentMap.set(n.id, []);
              childrenMap.set(n.id, []);
              inDegree.set(n.id, 0);
            });

            hardEdges.forEach(e => {
              if (nodeMap.has(e.from) && nodeMap.has(e.to)) {
                parentMap.get(e.to).push(e.from);
                childrenMap.get(e.from).push(e.to);
                inDegree.set(e.to, inDegree.get(e.to) + 1);
              }
            });

            async function generateSingleNode(node, parentHooks) {
              await sendSSE({ type: 'node_start', nodeId: node.id, name: node.name });

              let nodeContent = null;
              const nodePrompt = buildFallbackTutorNodePrompt(text, node, parentHooks, lang);
              try {
                const nodeRes = await streamDeepSeekJSONWithRetry([{ role: 'user', content: nodePrompt }], env.DEEPSEEK_API_KEY);
                nodeContent = nodeRes;
              } catch (err) {
                console.error(`[Fallback] Node ${node.id} failed:`, err);
              }

              if (!nodeContent || !nodeContent.coreConcepts || nodeContent.coreConcepts.length === 0) {
                console.warn(`[Fallback] Node ${node.id} empty or parse failed, retrying...`);
                const retryPrompt = buildFallbackTutorNodePromptRetry(text, node, lang);
                try {
                  const retryRes = await streamDeepSeekJSONWithRetry([{ role: 'user', content: retryPrompt }], env.DEEPSEEK_API_KEY);
                  if (retryRes && retryRes.coreConcepts && retryRes.coreConcepts.length > 0) {
                    nodeContent = retryRes;
                  }
                } catch (err) {
                  console.error(`[Fallback] Node ${node.id} retry failed:`, err);
                }
              }

              if (!nodeContent || !nodeContent.coreConcepts || nodeContent.coreConcepts.length === 0) {
                nodeContent = {
                  nodeId: node.id,
                  introQuestion: `What is ${node.name}?`,
                  coreConcepts: [
                    { title: node.name, content: 'Content generation failed. Please try regenerating the graph.', source: '' }
                  ],
                  checkActivities: [],
                  exitHook: node.name
                };
              }

              await sendSSE({ type: 'node_done', nodeId: node.id, data: nodeContent });
              return nodeContent;
            }

            const BATCH_SIZE = 5;
            const contentMap = new Map();

            while (true) {
              const batch = selectBatchNodes(skeleton.nodes, inDegree, parentMap, contentMap, BATCH_SIZE);
              if (batch.length === 0) break;

              const processedInBatch = new Set();
              let batchResult = null;

              // 尝试激进批量生成
              try {
                const batchPrompt = buildFallbackTutorDependencyBatchPrompt(text, batch, parentMap, contentMap, lang);
                batchResult = await streamDeepSeekJSONWithRetry([{ role: 'user', content: batchPrompt }], env.DEEPSEEK_API_KEY);
              } catch (batchErr) {
                console.error('[Fallback] Aggressive batch generation error:', batchErr);
              }

              // 处理批量结果中的节点
              if (batchResult) {
                for (const node of batch) {
                  if (batchResult[node.id] && batchResult[node.id].coreConcepts && batchResult[node.id].coreConcepts.length > 0) {
                    await sendSSE({ type: 'node_start', nodeId: node.id, name: node.name });
                    await sendSSE({ type: 'node_done', nodeId: node.id, data: batchResult[node.id] });
                    contentMap.set(node.id, batchResult[node.id]);
                    processedInBatch.add(node.id);
                  }
                }
              }

              // Fallback: 对失败的节点，只处理当前入度为0的
              const failedNodes = batch.filter(n => !processedInBatch.has(n.id));
              for (const node of failedNodes) {
                if (inDegree.get(node.id) === 0) {
                  const parentHooks = (parentMap.get(node.id) || [])
                    .map(pid => contentMap.get(pid)?.exitHook)
                    .filter(Boolean);
                  const nodeContent = await generateSingleNode(node, parentHooks);
                  contentMap.set(node.id, nodeContent);
                  processedInBatch.add(node.id);
                }
              }

              // 更新所有已处理节点的后继入度
              for (const nodeId of processedInBatch) {
                for (const childId of childrenMap.get(nodeId) || []) {
                  inDegree.set(childId, inDegree.get(childId) - 1);
                }
              }
            }

            const remainingNodes = skeleton.nodes.filter(n => !contentMap.has(n.id));
            for (const node of remainingNodes) {
              const parentHooks = (parentMap.get(node.id) || [])
                .map(pid => contentMap.get(pid)?.exitHook)
                .filter(Boolean);
              const nodeContent = await generateSingleNode(node, parentHooks);
              contentMap.set(node.id, nodeContent);
            }

            // 生成成功后再扣费
            if (visitorId) {
              const deducted = await deductVisitorCredits(visitorId, request, env, 'tutor_generate', tutorCost);
              if (!deducted) {
                console.warn('[Fallback Tutor Generate] Deduction failed after generation');
              }
            }

            await sendSSE({ type: 'complete' });

          } catch (err) {
            console.error('Fallback Tutor Generate error:', err);
            await sendSSE({ type: 'error', source: 'worker', message: err.message });
          } finally {
            await writer.close();
          }
        })());

        return new Response(readable, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            ...corsHeaders,
          },
        });

      } catch (err) {
        return new Response(JSON.stringify({
          error: err.message,
          stack: err.stack
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    /* ===== LOG USAGE (for user-provided API mode) ===== */
    if (url.pathname === '/api/log-usage' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { action, visitorId, mode } = body;

        // EXAM_STATS +1
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 如果带了 visitorId，记录一条 visitor_logs（credits_used = 0）
        if (visitorId) {
          await ensureVisitorTables(env);
          await env.DB.prepare(
            'INSERT INTO visitor_logs (visitor_id, action, credits_used) VALUES (?, ?, ?)'
          ).bind(visitorId, (action || 'unknown') + '_user_api', 0).run();
        }

        return createResponse(JSON.stringify({ success: true }));
      } catch (err) {
        return createResponse(JSON.stringify({ error: err.message }), 500);
      }
    }

    return createResponse('Not found', 404);
  },
};
