/**
 * Cloudflare Worker - GPA4.0 智能刷题助手后端服务
 * 支持 Kimi (Moonshot) API 文件上传和多模态生成
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

// 上传文件到 Kimi
async function uploadFileToKimi(fileBuffer, fileName, apiKey) {
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  
  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('purpose', 'file-extract');
  
  const response = await fetch('https://api.moonshot.cn/v1/files', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`File upload failed: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  return data.id;
}

// 获取文件内容
async function getFileContent(fileId, apiKey) {
  const response = await fetch(`https://api.moonshot.cn/v1/files/${fileId}/content`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Get file content failed: ${response.status} - ${errorText}`);
  }
  
  return await response.text();
}

// 调用 Kimi Chat API（文件内容放在 system 消息中）
async function callKimiWithFileContent(prompt, fileContent, apiKey) {
  const messages = [
    {
      role: 'system',
      content: 'You are an expert exam question creator. Create multiple-choice questions based on the study material provided below. Always respond with valid JSON format.'
    },
    {
      role: 'system',
      content: fileContent,  // 文件内容放在 system 消息中
    },
    {
      role: 'user',
      content: prompt
    }
  ];
  
  const payload = {
    model: 'kimi-k2-turbo-preview',
    messages: messages,
    stream: false,
    temperature: 1,
    enable_thinking: false,  // 关闭思考模式
    max_tokens: 127999,  // 最大输出长度，确保 JSON 不被截断
  };
  
  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI service error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// 从文本中提取JSON数组
function extractJSON(text) {
  let jsonStr = text.trim();
  jsonStr = jsonStr.replace(/```json\s*/gi, '');
  jsonStr = jsonStr.replace(/```\s*/g, '');
  
  const startIdx = jsonStr.indexOf('[');
  const endIdx = jsonStr.lastIndexOf(']');
  
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    throw new Error('No JSON array found in response');
  }
  
  jsonStr = jsonStr.substring(startIdx, endIdx + 1);
  
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    let repaired = jsonStr;
    repaired = repaired.replace(/,\s*]/g, ']');
    repaired = repaired.replace(/,\s*}/g, '}');
    repaired = repaired.replace(/'/g, '"');
    repaired = repaired.replace(/\n/g, ' ');
    
    try {
      return JSON.parse(repaired);
    } catch (e2) {
      throw new Error('Invalid JSON format after repair attempts');
    }
  }
}

// 延迟函数
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 调用 Kimi 生成指定页码范围和题号的题目
async function callKimiWithSubBatch(prompt, fileContent, apiKey, startPage, endPage, lang, subBatchIndex, subBatchCount) {
  const langInstruction = lang === 'zh' ? '使用中文' : 'Use English';
  
  // subBatchIndex: 0 表示第1组(1-10题), 1 表示第2组(11-20题)
  const questionStart = subBatchIndex * 10 + 1;
  const questionEnd = questionStart + 9;
  
  let subBatchPrompt = `${prompt}

STRICT PAGE RANGE REQUIREMENTS:
1. You MUST ONLY use content between page markers "-----[filename_page${startPage}]-----" and "-----[filename_page${endPage}]-----"
2. Do NOT use any content outside these markers
3. Look for the EXACT page marker format in the document headers: "-----[filename_pageN]-----" where N is the page number
4. Create questions ONLY from content found between these specific markers
5. The "source" field in your response MUST reference pages ${startPage}-${endPage} only

CONTENT FILTERING RULES:
1. DO NOT create questions about: course syllabus, instructor names, course titles, basic course information, or document metadata
2. DO NOT create questions based on: image captions, data source labels (e.g., "Data from WHO"), photo timestamps (e.g., "Photo taken in 2016"), or figure legends
3. Focus ONLY on: academic concepts, theories, definitions, processes, mechanisms, and substantive knowledge content
4. Questions should test understanding of the subject matter, not memorization of peripheral information

SUB-BATCH INSTRUCTION:
This is sub-batch ${subBatchIndex + 1} of ${subBatchCount} for pages ${startPage}-${endPage}.
Generate questions ${questionStart}-${questionEnd} from this page range.`;

  // 如果是第二组，添加避免重复的提示
  if (subBatchIndex > 0) {
    subBatchPrompt += ` Create DIFFERENT questions from previous sub-batches covering different aspects of the content.`;
  }

  const messages = [
    {
      role: 'system',
      content: `You are an expert exam question creator. Create multiple-choice questions based on the study material provided below. Always respond with valid JSON format. ${langInstruction} ONLY.`
    },
    {
      role: 'system',
      content: fileContent,
    },
    {
      role: 'user',
      content: subBatchPrompt
    }
  ];
  
  const payload = {
    model: 'kimi-k2-turbo-preview',
    messages: messages,
    stream: false,
    temperature: 1,
    enable_thinking: false,
    max_tokens: 120000,
  };
  
  // 添加 30 秒超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  
  try {
    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI service error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('AI service timeout: request took longer than 25 seconds');
    }
    throw error;
  }
}

// 带重试的子批次调用
async function callKimiSubBatchWithRetry(task, subBatchIndex, subBatchCount, fileContent, apiKey, lang, maxRetries = 2) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        console.log(`Retrying batch ${task.batchId} sub-batch ${subBatchIndex + 1}, attempt ${attempt + 1}/${maxRetries + 1}...`);
        await sleep(attempt * 1000);
      }
      
      const content = await callKimiWithSubBatch(
        task.prompt,
        fileContent,
        apiKey,
        task.startPage,
        task.endPage,
        lang,
        subBatchIndex,
        subBatchCount
      );
      
      const questions = extractJSON(content);
      
      return {
        batchId: task.batchId,
        subBatchIndex: subBatchIndex,
        success: true,
        questions: questions,
        startPage: task.startPage,
        endPage: task.endPage,
      };
    } catch (error) {
      lastError = error;
      console.error(`Batch ${task.batchId} sub-batch ${subBatchIndex + 1} attempt ${attempt + 1} failed:`, error.message);
    }
  }
  
  // 所有重试都失败了
  return {
    batchId: task.batchId,
    subBatchIndex: subBatchIndex,
    success: false,
    error: lastError.message,
    startPage: task.startPage,
    endPage: task.endPage,
  };
}

// 分批并发生成题目
async function generateQuestionsInBatches(fileContent, basePrompt, totalCount, pageCount, apiKey, lang) {
  const QUESTIONS_PER_BATCH = 20;  // 用于计算页码分割
  const SUB_BATCH_SIZE = 10;       // 每个子批次10题
  const batchCount = Math.ceil(totalCount / QUESTIONS_PER_BATCH);
  const pagesPerBatch = Math.floor(pageCount / batchCount) + 1;
  
  console.log(`Generating ${totalCount} questions in ${batchCount} batches (20Q/batch), each split into 2 sub-batches (10Q each), ${pagesPerBatch} pages per batch`);
  
  // 创建批次任务
  const batchTasks = [];
  for (let i = 0; i < batchCount; i++) {
    const startPage = i * pagesPerBatch + 1;
    const endPage = Math.min((i + 1) * pagesPerBatch, pageCount);
    const batchQuestionCount = Math.min(QUESTIONS_PER_BATCH, totalCount - i * QUESTIONS_PER_BATCH);
    
    batchTasks.push({
      batchId: i + 1,
      startPage,
      endPage,
      questionCount: batchQuestionCount,
      prompt: basePrompt,
    });
  }
  
  // 为每个批次创建子批次任务（每批20题拆成2个10题）
  const subBatchPromises = [];
  for (const task of batchTasks) {
    // 计算这个批次需要多少个子批次（通常是2个，最后一个可能只有1个）
    const subBatchCount = Math.ceil(task.questionCount / SUB_BATCH_SIZE);
    
    for (let j = 0; j < subBatchCount; j++) {
      subBatchPromises.push(callKimiSubBatchWithRetry(task, j, subBatchCount, fileContent, apiKey, lang, 2));
    }
  }
  
  // 并发执行所有子批次
  const results = await Promise.all(subBatchPromises);
  
  // 按批次ID和子批次索引排序，确保顺序正确
  results.sort((a, b) => {
    if (a.batchId !== b.batchId) return a.batchId - b.batchId;
    return a.subBatchIndex - b.subBatchIndex;
  });
  
  // 合并所有题目并重新编号
  let allQuestions = [];
  results.forEach((result) => {
    if (result.success && result.questions) {
      const subBatchQuestions = result.questions.map((q) => ({
        ...q,
        id: allQuestions.length + 1,  // 按顺序编号
      }));
      allQuestions = allQuestions.concat(subBatchQuestions);
    }
  });
  
  // 检查是否有失败的子批次
  const failedSubBatches = results.filter(r => !r.success);
  const actualCount = allQuestions.length;
  
  if (failedSubBatches.length > 0) {
    console.warn(`Partial success: ${actualCount}/${totalCount} questions generated. Failed batches:`, failedSubBatches);
    
    // 返回部分成功的结果和警告信息
    return {
      questions: allQuestions.slice(0, totalCount),
      partialSuccess: true,
      requestedCount: totalCount,
      actualCount: actualCount,
      failedCount: totalCount - actualCount,
      failedBatches: failedSubBatches.map(b => ({
        batchId: b.batchId,
        subBatchIndex: b.subBatchIndex,
        pages: `${b.startPage}-${b.endPage}`,
        error: b.error,
      })),
    };
  }
  
  // 完全成功
  return {
    questions: allQuestions.slice(0, totalCount),
    partialSuccess: false,
    requestedCount: totalCount,
    actualCount: actualCount,
  };
}

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

// 删除 Kimi 文件
async function deleteKimiFile(fileId, apiKey) {
  try {
    await fetch(`https://api.moonshot.cn/v1/files/${fileId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
  } catch (err) {
    console.error('Failed to delete file:', err);
  }
}

// ==================== 智谱 AI 文档解析服务 ====================

// 上传文件到智谱进行解析
async function uploadFileToGLM(fileBuffer, fileName, apiKey) {
  const blob = new Blob([fileBuffer], { type: 'application/pdf' });
  
  const formData = new FormData();
  formData.append('file', blob, fileName);
  formData.append('tool_type', 'lite');
  formData.append('file_type', 'PDF');
  
  const response = await fetch('https://open.bigmodel.cn/api/paas/v4/files/parser/create', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
    body: formData,
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GLM file upload failed: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  
  // 检查返回的 task_id，如果有 task_id 说明创建成功
  if (data.task_id) {
    console.log(`GLM task created: ${data.task_id}, message: ${data.message}`);
    return data.task_id;
  }
  
  // 如果有错误信息，抛出错误
  if (data.error) {
    throw new Error(`GLM upload failed: ${data.error.message || JSON.stringify(data.error)}`);
  }
  
  throw new Error(`GLM upload failed: ${data.message || 'Unknown error'}`);
}

// 轮询查询智谱解析结果
async function getGLMFileContent(taskId, apiKey, maxRetries = 30, intervalMs = 2000) {
  const url = `https://open.bigmodel.cn/api/paas/v4/files/parser/result/${taskId}/text`;
  
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GLM query failed: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.status === 'succeeded') {
      return data.content;
    }
    
    if (data.status === 'failed' || data.error) {
      throw new Error(`GLM parsing failed: ${data.error?.message || data.message || 'Unknown error'}`);
    }
    
    // 继续等待
    await sleep(intervalMs);
  }
  
  throw new Error('GLM parsing timeout: exceeded maximum retries');
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

// 使用 DeepSeek 分批生成题目
async function generateQuestionsWithDeepSeek(fileContent, totalCount, pageCount, lang, apiKey) {
  const QUESTIONS_PER_BATCH = 20;
  const batchCount = Math.ceil(totalCount / QUESTIONS_PER_BATCH);
  const pagesPerBatch = Math.floor(pageCount / batchCount) + 1;
  
  console.log(`[DEBUG] Starting DeepSeek generation: requestedCount=${totalCount}, pageCount=${pageCount}, batchCount=${batchCount}, pagesPerBatch=${pagesPerBatch}, lang=${lang}`);
  console.log(`[DEBUG] File content length: ${fileContent?.length || 0} chars`);
  
  // 创建批次任务
  const batchTasks = [];
  for (let i = 0; i < batchCount; i++) {
    const startPage = i * pagesPerBatch + 1;
    const endPage = Math.min((i + 1) * pagesPerBatch, pageCount);
    const batchQuestionCount = Math.min(QUESTIONS_PER_BATCH, totalCount - i * QUESTIONS_PER_BATCH);
    const startId = i * QUESTIONS_PER_BATCH + 1;
    const endId = startId + batchQuestionCount - 1;
    
    const langInstruction = lang === 'zh' ? '使用中文' : 'Use English';
    
    const prompt = `You are an expert exam question creator. Create exactly ${batchQuestionCount} multiple-choice questions based on the study material below.

CRITICAL REQUIREMENTS:
1. ${langInstruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. CRITICAL: For the "source" field, you MUST use the EXACT page marker format shown in the text (e.g., "-----[filename_page3]-----")
7. CRITICAL: The "id" field MUST start from ${startId} and increment by 1 for each question (e.g., ${startId}, ${startId + 1}, ${startId + 2}, ..., ${endId})

PAGE RANGE REQUIREMENTS:
You MUST ONLY use content between page markers "-----[filename_page${startPage}]-----" and "-----[filename_page${endPage}]-----".
The "source" field MUST reference pages ${startPage}-${endPage} only.

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
    "source": "EXACT page marker from text, e.g., -----[filename_page3]-----"
  }
]

Generate exactly ${batchQuestionCount} questions with ids from ${startId} to ${endId} from pages ${startPage}-${endPage}. Output valid JSON only.`;

    batchTasks.push({
      chunk_id: i + 1,
      messages: [
        { role: 'system', content: 'You are an expert exam question creator. Always respond with valid JSON format.' },
        { role: 'user', content: `Study Material:\n${fileContent.substring(0, 8000)}\n\n${prompt}` }
      ],
      startPage,
      endPage,
    });
  }
  
  // 并发调用 DeepSeek
  console.log(`[DEBUG] Starting ${batchTasks.length} concurrent DeepSeek calls`);
  const promises = batchTasks.map(async (task) => {
    console.log(`[DEBUG] Processing batch ${task.chunk_id}/${batchCount}, pages ${task.startPage}-${task.endPage}`);
    try {
      const result = await callDeepSeekWithRetry(task.messages, apiKey, 2);
      console.log(`[DEBUG] Batch ${task.chunk_id} DeepSeek call successful`);
      
      const content = result.choices?.[0]?.message?.content || '';
      console.log(`[DEBUG] Batch ${task.chunk_id} response content length: ${content.length}`);
      
      let questions;
      try {
        questions = extractJSON(content);
        console.log(`[DEBUG] Batch ${task.chunk_id} parsed ${questions.length} questions successfully`);
        // 验证返回的题目数量
        const expectedCount = Math.min(20, totalCount - (task.chunk_id - 1) * 20);
        if (questions.length < expectedCount) {
          console.warn(`[DEBUG] Batch ${task.chunk_id} returned ${questions.length} questions, expected ${expectedCount}`);
        }
      } catch (parseError) {
        console.error(`[DEBUG] Batch ${task.chunk_id} JSON parse error:`, parseError.message);
        console.error(`[DEBUG] Batch ${task.chunk_id} raw content (first 2000 chars):`, content.substring(0, 2000));
        console.error(`[DEBUG] Batch ${task.chunk_id} raw content (last 1000 chars):`, content.substring(content.length - 1000));
        throw parseError;
      }
      
      return {
        chunk_id: task.chunk_id,
        success: true,
        questions: questions,
        startPage: task.startPage,
        endPage: task.endPage,
      };
    } catch (error) {
      console.error(`[DEBUG] Batch ${task.chunk_id} failed:`, error.message);
      console.error(`[DEBUG] Batch ${task.chunk_id} error stack:`, error.stack);
      return {
        chunk_id: task.chunk_id,
        success: false,
        error: error.message,
        startPage: task.startPage,
        endPage: task.endPage,
      };
    }
  });
  
  const results = await Promise.all(promises);
  console.log(`[DEBUG] All batches completed. Results summary:`);
  results.forEach(r => {
    console.log(`[DEBUG]   Batch ${r.chunk_id}: success=${r.success}, questions=${r.questions?.length || 0}${r.error ? ', error=' + r.error : ''}`);
  });
  
  // 按批次排序并合并题目
  results.sort((a, b) => a.chunk_id - b.chunk_id);
  
  let allQuestions = [];
  results.forEach((result) => {
    if (result.success && result.questions) {
      const batchQuestions = result.questions.map((q) => ({
        ...q,
        id: allQuestions.length + 1,
      }));
      allQuestions = allQuestions.concat(batchQuestions);
    }
  });
  
  // 检查部分成功
  const failedBatches = results.filter(r => !r.success);
  const actualCount = allQuestions.length;
  
  console.log(`[DEBUG] Final result: ${actualCount}/${totalCount} questions generated, failedBatches=${failedBatches.length}`);
  
  if (failedBatches.length > 0) {
    console.warn(`[DEBUG] Partial success details:`);
    failedBatches.forEach(b => {
      console.warn(`[DEBUG]   Failed batch ${b.chunk_id}: error="${b.error}"`);
    });
    // 记录成功的批次供对比
    const successfulBatches = results.filter(r => r.success);
    console.log(`[DEBUG] Successful batches: ${successfulBatches.map(b => b.chunk_id).join(', ')}`);
    
    return {
      questions: allQuestions.slice(0, totalCount),
      partialSuccess: true,
      requestedCount: totalCount,
      actualCount: actualCount,
      failedCount: totalCount - actualCount,
    };
  }
  
  console.log(`[DEBUG] Full success: ${actualCount} questions generated`);
  return {
    questions: allQuestions.slice(0, totalCount),
    partialSuccess: false,
    requestedCount: totalCount,
    actualCount: actualCount,
  };
}

// 主入口
export default {
  async fetch(request, env, ctx) {
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

      // 3. 单条聊天接口 /chat (DeepSeek)
      if (path === '/chat' && request.method === 'POST') {
        const body = await request.json();
        
        if (!body.messages || !Array.isArray(body.messages)) {
          return createResponse(JSON.stringify({ error: 'messages field is required' }), 400);
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const result = await callDeepSeek(body.messages, env.DEEPSEEK_API_KEY);
        return createResponse(JSON.stringify(result));
      }

      // 4. 批量聊天接口 /chat/batch (DeepSeek)
      if (path === '/chat/batch' && request.method === 'POST') {
        console.log('[DEBUG] /chat/batch endpoint called');
        
        const body = await request.json();
        
        if (!body.items || !Array.isArray(body.items)) {
          console.error('[DEBUG] Error: items field is required');
          return createResponse(JSON.stringify({ error: 'items field is required' }), 400);
        }
        
        console.log(`[DEBUG] Received ${body.items.length} items for batch processing`);
        body.items.forEach((item, idx) => {
          console.log(`[DEBUG]   Item ${idx + 1}: chunk_id=${item.chunk_id}, messages_count=${item.messages?.length || 0}`);
        });

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        const promises = body.items.map(async (item) => {
          console.log(`[DEBUG] Processing chunk_id=${item.chunk_id}`);
          try {
            const result = await callDeepSeek(item.messages, env.DEEPSEEK_API_KEY, item.chunk_id);
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
        if (failed.length > 0) {
          console.error(`[DEBUG] Failed chunks:`, failed.map(f => ({ chunk_id: f.chunk_id, error: f.error })));
        }

        return createResponse(JSON.stringify({
          total: results.length,
          successful: results.filter(r => r.success).length,
          failed: failed.length,
          results: results,
        }));
      }

      // 5. 文件生成接口 /generate-with-file (Kimi - 用于 DocGenerate.html)
      if (path === '/generate-with-file' && request.method === 'POST') {
        const formData = await request.formData();
        const file = formData.get('file');
        const prompt = formData.get('prompt');
        const count = parseInt(formData.get('count')) || 20;
        const pageCount = parseInt(formData.get('pageCount')) || 0;
        const lang = formData.get('lang') || 'zh';
        
        if (!file) {
          return createResponse(JSON.stringify({ error: 'file is required' }), 400);
        }
        if (!prompt) {
          return createResponse(JSON.stringify({ error: 'prompt is required' }), 400);
        }
        if (!pageCount || pageCount <= 0) {
          return createResponse(JSON.stringify({ error: 'valid pageCount is required' }), 400);
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        // 第1步：接收文件
        const fileBuffer = await file.arrayBuffer();
        const fileName = file.name || 'document.pdf';
        
        // 第2步：上传文件到 Kimi
        const fileId = await uploadFileToKimi(fileBuffer, fileName, env.MOONSHOT_API_KEY);
        
        try {
          // 第3步：获取文件内容
          const fileContent = await getFileContent(fileId, env.MOONSHOT_API_KEY);
          
          // 第4步：分批并发生成题目
          const result = await generateQuestionsInBatches(
            fileContent,
            prompt,
            count,
            pageCount,
            env.MOONSHOT_API_KEY,
            lang
          );
          
          // 返回包含部分成功信息的结果
          return createResponse(JSON.stringify({
            success: true,
            content: JSON.stringify(result.questions),
            partialSuccess: result.partialSuccess,
            requestedCount: result.requestedCount,
            actualCount: result.actualCount,
            failedCount: result.failedCount || 0,
            warning: result.partialSuccess 
              ? `Due to server rate limiting, only ${result.actualCount} of ${result.requestedCount} questions were generated. Please try again later if you need more questions.`
              : undefined,
          }));
        } finally {
          // 清理：删除上传的文件
          await deleteKimiFile(fileId, env.MOONSHOT_API_KEY);
        }
      }

      // 6. 智谱解析 + DeepSeek 生成接口 (用于 Textgenerate.html PDF 处理)
      if (path === '/generate-with-glm-parse' && request.method === 'POST') {
        console.log('[DEBUG] /generate-with-glm-parse endpoint called');
        
        const formData = await request.formData();
        const file = formData.get('file');
        const count = parseInt(formData.get('count')) || 20;
        const pageCount = parseInt(formData.get('pageCount')) || 0;
        const lang = formData.get('lang') || 'zh';
        
        console.log(`[DEBUG] Request params: count=${count}, pageCount=${pageCount}, lang=${lang}, fileName=${file?.name || 'unknown'}`);
        
        if (!file) {
          console.error('[DEBUG] Error: file is required');
          return createResponse(JSON.stringify({ error: 'file is required' }), 400);
        }
        if (!pageCount || pageCount <= 0) {
          console.error('[DEBUG] Error: valid pageCount is required');
          return createResponse(JSON.stringify({ error: 'valid pageCount is required' }), 400);
        }

        const currentCount = parseInt(await env.EXAM_STATS.get('total_count')) || 0;
        await env.EXAM_STATS.put('total_count', (currentCount + 1).toString());

        try {
          // 第1步：接收PDF文件
          const fileBuffer = await file.arrayBuffer();
          const fileName = file.name || 'document.pdf';
          console.log(`[DEBUG] Received file: ${fileName}, size: ${fileBuffer.byteLength} bytes`);
          
          // 第2步：上传文件到智谱进行解析
          console.log('[DEBUG] Uploading file to GLM for parsing...');
          const taskId = await uploadFileToGLM(fileBuffer, fileName, env.GLM_API_KEY);
          console.log(`[DEBUG] GLM upload successful, taskId: ${taskId}`);
          
          // 第3步：轮询获取解析结果
          console.log(`[DEBUG] Waiting for GLM parsing...`);
          const fileContent = await getGLMFileContent(taskId, env.GLM_API_KEY);
          console.log(`[DEBUG] GLM parsing completed, content length: ${fileContent.length} chars`);
          
          // 第4步：使用 DeepSeek 分批生成题目
          console.log(`[DEBUG] Starting DeepSeek question generation...`);
          const result = await generateQuestionsWithDeepSeek(
            fileContent,
            count,
            pageCount,
            lang,
            env.DEEPSEEK_API_KEY
          );
          
          console.log(`[DEBUG] Generation complete: partialSuccess=${result.partialSuccess}, requested=${result.requestedCount}, actual=${result.actualCount}`);
          
          // 返回结果
          return createResponse(JSON.stringify({
            success: true,
            content: JSON.stringify(result.questions),
            partialSuccess: result.partialSuccess,
            requestedCount: result.requestedCount,
            actualCount: result.actualCount,
            failedCount: result.failedCount || 0,
            warning: result.partialSuccess 
              ? `Due to AI service limitations, only ${result.actualCount} of ${result.requestedCount} questions were generated. Please try again later if you need more questions.`
              : undefined,
          }));
        } catch (error) {
          console.error('[DEBUG] GLM parse and DeepSeek generate error:', error);
          console.error('[DEBUG] Error stack:', error.stack);
          return createResponse(
            JSON.stringify({ error: error.message || 'Internal Server Error' }),
            500
          );
        }
      }

      // 7. 404 未找到
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
