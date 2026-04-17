知识图谱导学功能 - 增量开发需求文档 (基于现有代码库)
1. 核心原则与复用策略
Agent 必须严格遵循以下原则：

存储本地化：所有生成的知识图谱数据（骨架、节点内容、学习进度）必须存储在客户端的 IndexedDB 中，与现有的题库存储方式保持一致。禁止引入后端 KV 或其他云存储来保存用户的图谱内容。

架构复用：完全复用现有 Worker 中 Google 鉴权、GCS 上传、Vertex AI 流式调用、Turnstile 验证逻辑。参考 DocGenerate.js 中的 SSE 处理和 IndexedDB 操作模式。

UI 风格一致：新的 tutor.html 和 tutor.js 的视觉风格（Tailwind CSS + 液态玻璃效果）和 i18n 实现方式必须与 index.html、DocGenerate.js 保持一致。

2. 前端增量要求
2.1 新增文件与模块
在现有前端目录下创建：

text
tutor.html          # 导学功能独立页面
tutor.js            # 主逻辑（或拆分为多个模块，见下文）
tutor.css           # （极少情况，优先复用全局样式）
2.2 功能模块拆分建议
为了代码清晰，建议 tutor.js 拆分为以下模块（通过 <script> 标签顺序引入，使用全局命名空间 TutorApp）：

js/tutor-db.js：封装 IndexedDB 操作（存储图谱、进度等）。

js/tutor-graph.js：负责使用 Vis.js 渲染 DAG 图谱，处理节点点击、状态更新。

js/tutor-panel.js：负责右侧学习面板的渲染与交互活动（选择题、排序、高亮等）。

js/tutor-sse.js：负责处理 Worker 的 SSE 流式响应，解析骨架和节点内容。

js/tutor-main.js：整合上述模块，处理上传、生成流程、页面初始化。

2.3 核心交互流程
上传与生成：

用户在 tutor.html 上传 PDF/文本文件。

复用 DocGenerate.js 中的 Turnstile 逻辑，获取 token。

发送 POST /api/tutor/generate 请求（携带文件、配置、token）。

Worker 返回 SSE 流，tutor-sse.js 处理 skeleton_done、node_start、node_done 等事件，实时更新图谱 UI。

生成过程中展示进度条和状态（参考 DocGenerate.js 中的 showProgressModal）。

图谱展示与学习：

生成完成后，图谱数据保存到 IndexedDB。

主区域显示 Vis.js 力导向图，节点颜色区分状态：未解锁（灰色）、可学习（蓝色）、已完成（绿色）、当前选中（橙色边框）。

点击可学习/已完成的节点，右侧面板展示 NodeContent（引子、概念卡片、检验活动）。

用户完成所有检验活动后，可点击“标记完成”，节点变绿，图谱中其子节点解锁。

进度保存与恢复：

学习进度（哪些节点已完成）实时存入 IndexedDB。

下次打开页面，自动加载上次的图谱和学习进度。

2.4 复用的关键代码模式
IndexedDB (Dexie)：参考 DocGenerate.js 中的 db 定义，新增 knowledgeGraphs 表。

javascript
// 新增表结构
db.version(7).stores({
    // ... 现有表
    knowledgeGraphs: '++id, name, createdAt, updatedAt',
    graphNodes: '++id, graphId, nodeId, [graphId+nodeId]',
    graphProgress: '++id, graphId, nodeId, [graphId+nodeId]'
});
SSE 处理：完全参考 DocGenerate.js 中 StreamingQuestionGenerator 的 generateAll 方法里的 SSE 读取逻辑（使用 ReadableStream 和 TextDecoder）。

文件上传与 Turnstile：复用 DocGenerate.js 中 startGeneration 函数获取 token 和构建 FormData 的方式。

3. 后端 Worker 增量要求
3.1 新增路由与处理函数
在 worker.js 中添加一个新路由 POST /api/tutor/generate，处理函数命名为 handleTutorGenerate。该函数应完全复用现有逻辑：

Turnstile 验证：从 formData 获取 turnstileToken，调用现有的验证逻辑（参考 /pdf_generate）。

GCS 上传：调用 uploadToGCS 将文件上传，获取 fileUri。

Vertex AI 流式调用：复用 streamVertex 和 getAccessToken。

SSE 响应：返回 text/event-stream，使用 TransformStream 和 ctx.waitUntil 异步处理（参考 /pdf_generate）。

3.2 核心生成逻辑 (AI Prompt)
生成过程分为两步，在一个 SSE 连接中完成：

骨架生成 (Skeleton)：

Prompt 要求 Gemini 分析文档，输出 GraphSkeleton JSON（节点列表、依赖边）。

要求 AI 为每个节点标记 importance (gateway / landmark)。

Worker 解析骨架，SSE 发送 skeleton_done 事件。

节点内容填充 (Node Content)：

Worker 对骨架节点进行拓扑排序（仅按 hard 边），得到生成队列。

顺序生成：遍历队列，对每个节点调用 Gemini，Prompt 中包含：节点信息、前置节点的 exitHook、importance。

AI 返回 NodeContent 后，立即 SSE 发送 node_done 事件。

所有节点生成完毕后，发送 complete 事件。后端不保存任何生成内容，全部推给前端。

3.3 数据结构约定 (JSON Schema)
Agent 需在 Worker 的 Prompt 中要求 AI 严格输出以下格式的 JSON。

GraphSkeleton:

json
{
  "nodes": [
    { "id": "derivative", "name": "导数", "importance": "gateway" },
    { "id": "limit", "name": "极限", "importance": "gateway" }
  ],
  "edges": [
    { "from": "limit", "to": "derivative", "type": "hard", "reason": "..." }
  ]
}
NodeContent:

json
{
  "nodeId": "derivative",
  "introQuestion": "汽车仪表盘上的瞬时速度，既然是一瞬间，时间没流逝，怎么算出来的？",
  "coreConcepts": [
    { "title": "直觉理解", "content": "..." },
    { "title": "符号定义", "content": "..." }
  ],
  "checkActivities": [
    {
      "type": "choice",
      "question": "一个函数在某点不连续，它可能在该点可导吗？",
      "options": ["可能", "不可能"],
      "correct": 1
    }
  ],
  "exitHook": "学生现在知道导数描述了函数在某点的瞬时变化率，几何上是切线斜率。"
}
4. 部署与集成清单
Agent 需要提供：

前端文件：

tutor.html、tutor.js（及拆分后的模块文件）、tutor.css（如果需要）。

包含完整的 i18n 文案 Key 列表和默认中英文文案。

Worker 代码片段：

handleTutorGenerate 函数及其辅助函数（如拓扑排序）。

清晰的代码注释，指明在 worker.js 的哪个位置添加路由判断。

集成说明：

如何在前端导航栏（如 index.html）添加进入 tutor.html 的链接。

如何配置环境变量（确保 GEMINI_API_KEY 等已存在，无需新增）。

如何在 Dexie 版本升级时安全地新增表。

5. 关键实现细节提示
拓扑排序：在 Worker 中实现一个简单的 Kahn 算法，因为节点数量通常不多。

Landmark 节点处理：前端渲染时，若 importance: "landmark"，则学习面板不显示检验活动，底部按钮文案为“知道了”，点击后直接标记完成。

依赖解锁逻辑：前端维护一个 completedNodes Set，节点可点击的条件是它的所有 hard 前置节点都在 Set 中。

清理：生成完成后，Worker 应调用 deleteFromGCS 清理上传的临时文件。