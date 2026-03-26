/**
 * Worker - GCS + Vertex AI + 延迟清理版本
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

/* ==================== AUTH ==================== */

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
  
  if (!res.ok && res.status !== 404) { // 404 表示文件已不存在，也算成功
    throw new Error(`Failed to delete GCS file: ${await res.text()}`);
  }
}

/* ==================== VERTEX AI ==================== */

async function streamVertex(fileUri, prompt, env, token) {
  // 注意：使用带版本号的模型 ID
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

/* ==================== DeepSeek (for organize.html) ==================== */

// 调用 DeepSeek API（保留原有功能）
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

// 延迟函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 调用 DeepSeek API 生成题目（带重试）
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

    /* ===== CHAT (DeepSeek for organize.html) ===== */
    if (url.pathname === '/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        
        if (!body.messages || !Array.isArray(body.messages)) {
          return createResponse(JSON.stringify({ error: 'messages field is required' }), 400);
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const result = await callDeepSeekWithRetry(body.messages, env.DEEPSEEK_API_KEY);
        return createResponse(JSON.stringify(result));
      } catch (error) {
        console.error('[DEBUG] /chat error:', error);
        return createResponse(JSON.stringify({ error: error.message }), 500);
      }
    }

    /* ===== CHAT BATCH (DeepSeek for organize.html) ===== */
    if (url.pathname === '/chat/batch' && request.method === 'POST') {
      console.log('[DEBUG] /chat/batch endpoint called');
      
      try {
        const body = await request.json();
        
        if (!body.items || !Array.isArray(body.items)) {
          console.error('[DEBUG] Error: items field is required');
          return createResponse(JSON.stringify({ error: 'items field is required' }), 400);
        }
        
        console.log(`[DEBUG] Received ${body.items.length} items for batch processing`);

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
        const form = await request.formData();
        const file = form.get('file');

        if (!file) {
          return createResponse(JSON.stringify({ error: 'No file received' }), 400);
        }

        // 增加计数
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

              // 提取 text 字段
              const textRegex = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
              let match;
              while ((match = textRegex.exec(rawBuffer)) !== null) {
                try {
                  const text = JSON.parse(`"${match[1]}"`);
                  if (text) {
                    await sendSSE({ type: 'chunk', data: text });
                  }
                } catch (e) {
                  // 忽略解析错误
                }
              }
              
              // 清空已处理部分
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
            // 🔥 重要：不再自动删除 GCS 文件，改为前端完成后显式调用 /cleanup
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
    // 新增：所有批次完成后调用，删除 GCS 文件
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