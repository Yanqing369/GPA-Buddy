/**
 * Cloudflare Worker - GPA4.0 智能刷题助手后端服务
 * 替换原来的 Python FastAPI 后端
 */

// CORS 响应头配置
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// 创建带 CORS 的响应
function createResponse(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

// 处理 OPTIONS 预检请求
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// 调用 DeepSeek API
async function callDeepSeek(messages, apiKey, chunkId = null) {
  const payload = {
    model: 'deepseek-chat',
    messages: messages,
    stream: false,
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
    throw new Error(`Chunk ${chunkId}: AI服务出错，状态码：${response.status}`);
  }

  return await response.json();
}

// 主入口
export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 1. 健康检查 /ping
      if (path === '/ping' && request.method === 'GET') {
        return createResponse(JSON.stringify({ status: 'pong' }));
      }

      // 2. 统计接口 /stats
      if (path === '/stats' && request.method === 'GET') {
        const count = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        return createResponse(JSON.stringify({ total: count }));
      }

      // 3. 单条聊天接口 /chat
      if (path === '/chat' && request.method === 'POST') {
        const body = await request.json();
        
        if (!body.messages || !Array.isArray(body.messages)) {
          return createResponse(JSON.stringify({ error: 'messages field is required' }), 400);
        }

        // 增加计数
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 调用 DeepSeek
        const result = await callDeepSeek(body.messages, env.DEEPSEEK_API_KEY);
        return createResponse(JSON.stringify(result));
      }

      // 4. 批量聊天接口 /chat/batch
      if (path === '/chat/batch' && request.method === 'POST') {
        const body = await request.json();
        
        if (!body.items || !Array.isArray(body.items)) {
          return createResponse(JSON.stringify({ error: 'items field is required' }), 400);
        }

        // 只增加一次计数（算作一次生成操作）
        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 并发处理所有分段
        const promises = body.items.map(async (item) => {
          try {
            const result = await callDeepSeek(item.messages, env.DEEPSEEK_API_KEY, item.chunk_id);
            return {
              chunk_id: item.chunk_id,
              success: true,
              data: result,
            };
          } catch (error) {
            return {
              chunk_id: item.chunk_id,
              success: false,
              error: error.message,
            };
          }
        });

        const results = await Promise.all(promises);
        const failed = results.filter(r => !r.success);

        return createResponse(JSON.stringify({
          total: results.length,
          successful: results.filter(r => r.success).length,
          failed: failed.length,
          results: results,
        }));
      }

      // 5. 404 未找到
      return createResponse(JSON.stringify({ error: 'Not Found' }), 404);

    } catch (error) {
      console.error('Worker error:', error);
      return createResponse(
        JSON.stringify({ error: error.message || 'Internal Server Error' }),
        500
      );
    }
  },
};
