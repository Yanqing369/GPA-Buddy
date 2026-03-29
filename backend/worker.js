/**
 * Worker - GCS + Vertex AI + 用户登录系统
 * 架构：上传 → 并行生成 → 最后统一清理
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function createResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function handleOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
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

// 从请求中提取用户信息
async function getUserFromRequest(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('No Authorization header or invalid format');
    return null;
  }
  
  const token = authHeader.slice(7);
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

/* ==================== GOOGLE OAUTH ==================== */

async function handleGoogleLogin(request, env) {
  const redirectUri = getRedirectUri(request, env);
  const state = generateState();
  
  // 存储state到KV（5分钟过期），同时存储前端域名用于跳转回来
  const frontendUrl = getFrontendUrl(env);
  await env.EXAM_STATS.put(`oauth_state:${state}`, JSON.stringify({ redirectUri, frontendUrl }), { expirationTtl: 300 });
  
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: state,
  });
  
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302);
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
  
  const { redirectUri, frontendUrl } = JSON.parse(stateData);
  
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
  
  if (!user) {
    // 创建新用户
    const result = await env.DB.prepare(
      'INSERT INTO users (email, name, avatar, google_id, account_type) VALUES (?, ?, ?, ?, ?)'
    ).bind(googleUser.email, googleUser.name, googleUser.picture, googleUser.id, 'free').run();
    
    user = await env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first();
    
    // 初始化余额记录
    await env.DB.prepare(
      'INSERT INTO balances (user_id, amount, free_quota_daily, free_quota_used, last_reset_date) VALUES (?, 0, 10, 0, date("now"))'
    ).bind(user.id).run();
  } else {
    // 更新最后登录时间
    await env.DB.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?')
      .bind(user.id).run();
  }
  
  // 生成JWT
  const jwt = await signJWT(
    { userId: user.id, email: user.email, type: user.account_type },
    env.JWT_SECRET
  );
  
  // 重定向到前端首页，带上token
  return Response.redirect(`${frontendUrl}/index.html?login=success&token=${jwt}`, 302);
}

function generateState() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getRedirectUri(request, env) {
  // Worker 的域名用于 OAuth 回调（Google 会回调到这个地址）
  // 这必须与 Google Cloud Console 中配置的 URI 完全匹配
  const workerUrl = new URL(request.url).origin;
  return `${workerUrl}/auth/google/callback`;
}

function getFrontendUrl(env) {
  // 从环境变量获取前端域名
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
    balance: balance ? {
      amount: balance.amount,
      freeQuotaDaily: balance.free_quota_daily,
      freeQuotaUsed: balance.free_quota_used,
      freeQuotaLeft: Math.max(0, balance.free_quota_daily - balance.free_quota_used),
    } : null,
  }));
}

async function handleLogout(request, env) {
  // JWT是无状态的，客户端删除token即可
  return createResponse(JSON.stringify({ success: true }));
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

async function streamVertex(fileUri, prompt, env, token) {
  const modelId = env.GCP_MODEL_ID || 'gemini-2.5-flash-lite';
  const endpoint = `https://${env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/publishers/google/models/${modelId}:streamGenerateContent`;

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
  const endpoint = `https://${env.GCP_LOCATION}-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/${env.GCP_LOCATION}/publishers/google/models/${modelId}:streamGenerateContent`;

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
    model: 'deepseek-chat',
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

/* ==================== MAIN ==================== */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return handleOptions();

    const url = new URL(request.url);

    /* ===== AUTH ROUTES ===== */
    if (url.pathname === '/auth/google') {
      return handleGoogleLogin(request, env);
    }
    
    if (url.pathname === '/auth/google/callback') {
      return handleGoogleCallback(request, env);
    }
    
    if (url.pathname === '/auth/me' && request.method === 'GET') {
      return handleGetMe(request, env);
    }
    
    if (url.pathname === '/auth/logout' && request.method === 'POST') {
      return handleLogout(request, env);
    }

    /* ===== BALANCE ROUTES ===== */
    if (url.pathname === '/api/balance' && request.method === 'GET') {
      return handleGetBalance(request, env);
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

    /* ===== CHAT (DeepSeek) ===== */
    if (url.pathname === '/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        
        if (!body.messages || !Array.isArray(body.messages)) {
          return createResponse(JSON.stringify({ error: 'messages field is required' }), 400);
        }

        // 检查用户配额（如果已登录）
        const user = await getUserFromRequest(request, env);
        if (user) {
          const quotaCheck = await checkAndConsumeQuota(user.id, env);
          if (!quotaCheck.allowed) {
            return createResponse(JSON.stringify({ 
              error: quotaCheck.reason,
              code: 'QUOTA_EXCEEDED'
            }), 403);
          }
        } else {
          // 访客模式：增加计数
          const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
          await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());
        }

        const result = await callDeepSeekWithRetry(body.messages, env.DEEPSEEK_API_KEY);
        return createResponse(JSON.stringify(result));
      } catch (error) {
        console.error('[DEBUG] /chat error:', error);
        return createResponse(JSON.stringify({ error: error.message }), 500);
      }
    }

    /* ===== CHAT BATCH ===== */
    if (url.pathname === '/chat/batch' && request.method === 'POST') {
      console.log('[DEBUG] /chat/batch endpoint called');
      
      try {
        const body = await request.json();
        
        if (!body.items || !Array.isArray(body.items)) {
          console.error('[DEBUG] Error: items field is required');
          return createResponse(JSON.stringify({ error: 'items field is required' }), 400);
        }
        
        console.log(`[DEBUG] Received ${body.items.length} items for batch processing`);

        // 检查配额
        const user = await getUserFromRequest(request, env);
        if (user) {
          for (let i = 0; i < body.items.length; i++) {
            const quotaCheck = await checkAndConsumeQuota(user.id, env);
            if (!quotaCheck.allowed) {
              return createResponse(JSON.stringify({ 
                error: `Quota exceeded after ${i} items. ${quotaCheck.reason}`,
                code: 'QUOTA_EXCEEDED'
              }), 403);
            }
          }
        } else {
          const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
          await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());
        }

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
        const form = await request.formData();
        const file = form.get('file');

        if (!file) {
          return createResponse(JSON.stringify({ error: 'No file received' }), 400);
        }

        // 检查配额（如果已登录）
        const user = await getUserFromRequest(request, env);
        if (user) {
          const quotaCheck = await checkAndConsumeQuota(user.id, env);
          if (!quotaCheck.allowed) {
            return createResponse(JSON.stringify({ 
              error: quotaCheck.reason,
              code: 'QUOTA_EXCEEDED'
            }), 403);
          }
        } else {
          const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
          await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());
        }

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

    /* ===== GENERATE ===== */
    if (url.pathname === '/generate') {
      try {
        const { fileUris, prompt } = await request.json();
        const fileUri = fileUris[0];

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

    /* ===== GENERATE FROM TEXT ===== */
    if (url.pathname === '/generate/text' && request.method === 'POST') {
      try {
        const { text, prompt, batchIndex, totalBatches } = await request.json();
        
        if (!text || !prompt) {
          return createResponse(JSON.stringify({ error: 'text and prompt are required' }), 400);
        }

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

    return createResponse('Not found', 404);
  },
};
