/**
 * user-api-client.js - 前端直连第三方 OpenAI-compatible API
 * 复现 backend/worker.js 中 /fallback/tutor_generate 和 /fallback/pdf_generate 的核心逻辑
 * 所有 Prompt Builder 均与 backend/worker.js 保持一致
 */

/* ==================== Config ==================== */
const UserAPIConfig = {
  getBaseUrl() {
    return (localStorage.getItem('user_api_base_url') || '').trim();
  },
  getApiKey() {
    return (localStorage.getItem('user_api_key') || '').trim();
  },
  getModel() {
    return (localStorage.getItem('user_api_model') || '').trim() || 'deepseek-v4-flash';
  },
  isConfigured() {
    return !!(this.getBaseUrl() && this.getApiKey());
  },
  getChatEndpoint() {
    let base = this.getBaseUrl().replace(/\/$/, '');
    if (base.includes('/chat/completions')) return base;
    return `${base}/v1/chat/completions`;
  },
  save(baseUrl, apiKey, model) {
    localStorage.setItem('user_api_base_url', baseUrl.trim());
    localStorage.setItem('user_api_key', apiKey.trim());
    if (model !== undefined) localStorage.setItem('user_api_model', model.trim());
  },
  clear() {
    localStorage.removeItem('user_api_base_url');
    localStorage.removeItem('user_api_key');
    localStorage.removeItem('user_api_model');
  }
};

/* ==================== OpenAI SSE Client ==================== */
async function streamOpenAIChat(messages, onChunk = null, abortSignal = null) {
  const response = await fetch(UserAPIConfig.getChatEndpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${UserAPIConfig.getApiKey()}`
    },
    body: JSON.stringify({
      model: UserAPIConfig.getModel(),
      messages,
      stream: true,
      max_tokens: 32000,
      temperature: 0.7,
      // 不传入 response_format，兼容更多第三方代理
    }),
    signal: abortSignal
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API error: ${response.status}, ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        if (!dataStr) continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.reasoning_content) continue;
          if (delta?.content) {
            fullText += delta.content;
            if (onChunk) onChunk(delta.content);
          }
        } catch (e) {
          // ignore parse error for malformed lines
        }
      }
    }

    // process remaining buffer
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (delta?.content) {
              fullText += delta.content;
              if (onChunk) onChunk(delta.content);
            }
          } catch (e) {}
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

async function streamOpenAIChatWithRetry(messages, onChunk = null, abortSignal = null, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
      return await streamOpenAIChat(messages, onChunk, abortSignal);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`[UserAPI] streamOpenAIChat attempt ${attempt + 1} failed:`, err.message);
    }
  }
}

/* ==================== Helpers (mirrored from worker.js) ==================== */
function getLangInstruction(lang) {
  if (lang === 'zh') return '使用中文';
  if (lang === 'zh-TW') return '使用繁體中文';
  if (lang === 'ko') return '한국어를 사용하세요';
  return 'Use English';
}

function safeParseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
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

  // 0. upgrade soft to hard for nodes with no hard incoming edges
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

  // 1. filter invalid edges
  let validEdges = skeleton.edges.filter(e => nodeIds.has(e.from) && nodeIds.has(e.to));

  // 2. limit out-degree and avoid cycles
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

function splitTextByPageMarkers(text, numChunks) {
  const markerRegex = /-----\[.+?_page\d+\]-----\n/g;
  const matches = [...text.matchAll(markerRegex)];
  if (matches.length === 0) {
    const chunkSize = Math.ceil(text.length / numChunks);
    const chunks = [];
    for (let i = 0; i < numChunks; i++) {
      chunks.push(text.slice(i * chunkSize, (i + 1) * chunkSize));
    }
    return chunks;
  }
  const pages = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    pages.push(text.slice(start, end));
  }
  const pagesPerChunk = Math.ceil(pages.length / numChunks);
  const chunks = [];
  for (let i = 0; i < numChunks; i++) {
    const start = i * pagesPerChunk;
    const end = Math.min((i + 1) * pagesPerChunk, pages.length);
    chunks.push(pages.slice(start, end).join('\n'));
  }
  return chunks;
}

/* ==================== Prompt Builders (mirrored from worker.js) ==================== */
function buildFallbackBatchPrompt(textChunk, batchIndex, totalBatches, lang, startId, originalFileName, customPrompt = '') {
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

Required JSON format:
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

Generate exactly 20 questions from the provided text. Use the EXACT source format. Output valid JSON only.${customSection}`;
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


/* ==================== Tutor Engine ==================== */
const UserAPITutorEngine = {
  async generate(text, lang, customPrompt, callbacks, abortSignal) {
    const { onSkeleton, onNodeStart, onNodeDone, onComplete, onError, onProgress } = callbacks;

    try {
      // 1. Skeleton generation
      const skeletonPrompt = buildFallbackTutorSkeletonPrompt(text, lang, customPrompt);
      const skeletonJson = await streamOpenAIChatWithRetry(
        [{ role: 'user', content: skeletonPrompt }],
        null,
        abortSignal
      );
      const skeleton = safeParseJSON(skeletonJson);
      if (!skeleton || !Array.isArray(skeleton.nodes) || !Array.isArray(skeleton.edges)) {
        throw new Error('Invalid skeleton JSON from API');
      }
      if (skeleton.nodes.length > 25) {
        skeleton.nodes = skeleton.nodes.slice(0, 25);
      }
      sanitizeSkeleton(skeleton);
      onSkeleton(skeleton);

      // 2. Build topology (hard edges only for scheduling)
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

      // 3. Single node generation with retry and fallback
      async function generateSingleNode(node, parentHooks) {
        await onNodeStart(node.id, node.name);

        let nodeContent = null;
        const nodePrompt = buildFallbackTutorNodePrompt(text, node, parentHooks, lang);
        try {
          const nodeRes = await streamOpenAIChatWithRetry(
            [{ role: 'user', content: nodePrompt }],
            null,
            abortSignal
          );
          nodeContent = safeParseJSON(nodeRes);
        } catch (err) {
          console.error(`[UserAPI Tutor] Node ${node.id} failed:`, err);
        }

        if (!nodeContent || !nodeContent.coreConcepts || nodeContent.coreConcepts.length === 0) {
          console.warn(`[UserAPI Tutor] Node ${node.id} empty or parse failed, retrying...`);
          const retryPrompt = buildFallbackTutorNodePromptRetry(text, node, lang);
          try {
            const retryRes = await streamOpenAIChatWithRetry(
              [{ role: 'user', content: retryPrompt }],
              null,
              abortSignal
            );
            const retryContent = safeParseJSON(retryRes);
            if (retryContent && retryContent.coreConcepts && retryContent.coreConcepts.length > 0) {
              nodeContent = retryContent;
            }
          } catch (err) {
            console.error(`[UserAPI Tutor] Node ${node.id} retry failed:`, err);
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

        await onNodeDone(node.id, nodeContent);
        return nodeContent;
      }

      // 4. Dependency-aware batch processing
      const BATCH_SIZE = 5;
      const contentMap = new Map();
      let processedCount = 0;

      while (true) {
        const batch = selectBatchNodes(skeleton.nodes, inDegree, parentMap, contentMap, BATCH_SIZE);
        if (batch.length === 0) break;

        const processedInBatch = new Set();
        let batchResult = null;

        // Aggressive batch generation
        try {
          const batchPrompt = buildFallbackTutorDependencyBatchPrompt(text, batch, parentMap, contentMap, lang);
          const batchRes = await streamOpenAIChatWithRetry(
            [{ role: 'user', content: batchPrompt }],
            null,
            abortSignal
          );
          batchResult = safeParseJSON(batchRes);
        } catch (batchErr) {
          console.error('[UserAPI Tutor] Aggressive batch generation error:', batchErr);
        }

        // Process batch results
        if (batchResult) {
          for (const node of batch) {
            if (batchResult[node.id] && batchResult[node.id].coreConcepts && batchResult[node.id].coreConcepts.length > 0) {
              await onNodeStart(node.id, node.name);
              await onNodeDone(node.id, batchResult[node.id]);
              contentMap.set(node.id, batchResult[node.id]);
              processedInBatch.add(node.id);
              processedCount++;
            }
          }
        }

        // Fallback: process failed nodes with inDegree === 0
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

        // Update in-degrees
        for (const nodeId of processedInBatch) {
          for (const childId of childrenMap.get(nodeId) || []) {
            inDegree.set(childId, inDegree.get(childId) - 1);
          }
        }
      }

      // Process remaining isolated nodes
      const remainingNodes = skeleton.nodes.filter(n => !contentMap.has(n.id));
      for (const node of remainingNodes) {
        const parentHooks = (parentMap.get(node.id) || [])
          .map(pid => contentMap.get(pid)?.exitHook)
          .filter(Boolean);
        const nodeContent = await generateSingleNode(node, parentHooks);
        contentMap.set(node.id, nodeContent);
      }

      onComplete();
    } catch (err) {
      console.error('[UserAPI Tutor] Generate error:', err);
      onError(err.message, 'user_api');
    }
  }
};

/* ==================== PDF / DocGenerate Engine ==================== */
const UserAPIPdfEngine = {
  async generate(text, config, callbacks, abortSignal) {
    const { questionCount, lang, customPrompt, originalFileName } = config;
    const { onBatch0Chunk, onBatch0Done, onFinalResult, onDone, onError } = callbacks;

    try {
      const totalBatches = Math.ceil(questionCount / 20);
      const chunks = splitTextByPageMarkers(text, totalBatches);
      const allResults = [];

      // Batch 0 with streaming
      const batch0Text = chunks[0] || '';
      const batch0Prompt = buildFallbackBatchPrompt(batch0Text, 0, totalBatches, lang, 1, originalFileName, customPrompt);

      let batch0Buffer = '';
      const batch0Result = await streamOpenAIChatWithRetry(
        [{ role: 'user', content: batch0Prompt }],
        (chunk) => {
          batch0Buffer += chunk;
          onBatch0Chunk(chunk);
        },
        abortSignal
      );

      // Try to parse the complete batch0 result for accumulation
      let batch0Questions = [];
      try {
        const parsed = JSON.parse(batch0Result);
        if (Array.isArray(parsed)) batch0Questions = parsed;
      } catch (e) {
        // If full parse fails, try to extract from buffer
        batch0Questions = extractCompleteObjects(batch0Buffer);
      }
      allResults.push(...batch0Questions);
      onBatch0Done(batch0Questions.length);

      // Other batches in parallel
      if (totalBatches > 1) {
        const otherPromises = [];
        for (let i = 1; i < totalBatches; i++) {
          const chunkText = chunks[i] || '';
          const startId = i * 20 + 1;
          const prompt = buildFallbackBatchPrompt(chunkText, i, totalBatches, lang, startId, originalFileName, customPrompt);
          otherPromises.push(
            streamOpenAIChatWithRetry([{ role: 'user', content: prompt }], null, abortSignal)
              .then(res => {
                try {
                  const parsed = JSON.parse(res);
                  return Array.isArray(parsed) ? parsed : [];
                } catch (e) {
                  return extractCompleteObjects(res);
                }
              })
              .catch(err => {
                console.error(`[UserAPI PDF] Batch ${i} failed:`, err);
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

      onFinalResult({
        data: allResults,
        tokenCount: 0,
        generatedCount,
        requestedCount: questionCount,
        partial
      });
      onDone();
    } catch (err) {
      console.error('[UserAPI PDF] Generate error:', err);
      onError(err.message);
    }
  }
};

/* ==================== Usage Logger ==================== */
async function logUsageToWorker(action) {
  try {
    const visitorId = typeof Visitor !== 'undefined' ? Visitor.getId() : null;
    const baseUrl = typeof API_BASE !== 'undefined' ? API_BASE : 'https://moyuxiaowu.org';
    await fetch(`${baseUrl}/api/log-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, visitorId, mode: 'user_api' })
    });
  } catch (e) {
    // Silently fail; do not block user
  }
}

/* ==================== Shared Helpers ==================== */
function extractCompleteObjects(buffer) {
  const questions = [];
  const regex = /\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}/g;
  let match;
  while ((match = regex.exec(buffer)) !== null) {
    try {
      const obj = JSON.parse(match[0]);
      if (obj.question && obj.options && obj.correctAnswer) {
        if (!questions.find(q => q.question === obj.question)) {
          questions.push(obj);
        }
      }
    } catch (e) {
      // incomplete object, skip
    }
  }
  return questions;
}
