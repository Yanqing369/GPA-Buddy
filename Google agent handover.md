# Google Agent Handover

> 交接给下一个会话：关于 GPA-Buddy / 请出题 项目接入 Google ADK + Agent Runtime 的试点方案。

---

## 1. 背景与目标

### 项目
- 项目名：**GPA-Buddy / 请出题**
- 仓库路径：`F:/python_code/AI_reviewer/ver8-moodle-integration`
- 现有架构：纯前端静态 HTML + vanilla JS，后端为 Cloudflare Worker (`backend/worker.js`)，使用 D1 / KV / R2 / GCS，已接入 Vertex AI (Gemini) 和 DeepSeek。
- 相关后端接口：
  - `/api/ask`：刷题页实时答疑（当前直连 Vertex Gemini）
  - `/api/tutor/generate`：知识图谱导学
  - `/pdf_generate`、`/text_generate`：从资料生成题库

### 黑客松评分要求
官方要求 **Ecosystem Execution**： Robustly leveraging Gemini Enterprise components, such as Agent Development Kit, Agent Runtime, Agent Registry and Agent Gateway.

### 本次试点目标
- 从 **问答接口 `/api/ask`** 开始试点。
- 前端增加手动开关，用户可选择：
  - **直连 Gemini**（现有链路）
  - **ADK Agent**（新链路）
- 链路变为：

```
前端 → Cloudflare Worker（鉴权/积分/Turnstile） → Agent Runtime（ADK Agent） → Gemini
```

- 最终展示：ADK + Agent Runtime + Agent Registry（自动注册）+ 可选 Agent Gateway。

---

## 2. 已确认的环境与权限

### 已安装的本地 Skills
全部 7 个 Google ADK skills 已安装到项目级目录：

```
.kimi-code/skills/
├── google-agents-cli-workflow/
├── google-agents-cli-adk-code/
├── google-agents-cli-scaffold/
├── google-agents-cli-eval/
├── google-agents-cli-deploy/
├── google-agents-cli-publish/
└── google-agents-cli-observability/
```

可在新会话中用 slash 命令调用：
- `/skill:google-agents-cli-workflow`
- `/skill:google-agents-cli-adk-code`
- `/skill:google-agents-cli-deploy`
- `/skill:google-agents-cli-publish`

### GCP 环境确认
- 项目：`gpa-buddy`
- Billing 已绑定
- 已开通：**Agent Platform**（含 ADK、Agent Runtime、Agent Registry、Gateways、Policies、MCP、RAG Engine、Vector Search、Memory Bank、Sessions）
- **Agent Runtime 已确认可用**：菜单路径 `Agent Platform → 代理 → 部署` 显示 "Agent Runtime 上的部署"
- 现有 Agent Runtime 实例：**`AGENT_DESIGNER_GENERATED_DO_NOT_DELETE`**（us-west1， Oregon）
  - **⚠️ 不要删除或修改这个实例**，它是 Agent Platform 自动生成的系统代理。
- 左侧菜单没有单独的 **Gemini Enterprise**，但这不影响：Agent Platform 已经包含所需组件。

### 当前项目已使用的 GCP 服务
- GCS bucket：`course-materials`
- Vertex AI（Gemini 2.5 Flash Lite / Pro）
- Worker 通过 `GCP_PRIVATE_KEY` + `GCP_CLIENT_EMAIL` 服务账号调用 Vertex AI

---

## 3. 架构方案（已确定）

### 3.1 链路对比

| 模式 | 链路 | 用途 |
|------|------|------|
| 直连 Gemini | 前端 → Worker → Vertex `generateContent` API | 默认/稳定模式 |
| ADK Agent | 前端 → Worker → Agent Runtime → Gemini | 试点/演示模式 |

### 3.2 数据流

```text
[practice.html]        [backend/worker.js]              [Agent Runtime]              [Gemini]
    │                         │                                  │                         │
    │  POST /api/ask          │                                  │                         │
    │  { useAdkAgent: true }  │                                  │                         │
    │ ──────────────────────> │                                  │                         │
    │                         │  1. 校验用户/访客额度            │                         │
    │                         │  2. Turnstile 校验               │                         │
    │                         │  3. 拼装上下文 + 图片            │                         │
    │                         │  4. 转发到 Agent Runtime         │                         │
    │                         │ ───────────────────────────────> │                         │
    │                         │                                  │  ADK Agent 处理          │
    │                         │                                  │  tools + state          │
    │                         │  <────────────────────────────── │                         │
    │  <───────────────────── │                                  │                         │
```

### 3.3 为什么 Worker 不能删掉

Cloudflare Worker 仍负责：
- 用户登录态校验（JWT）
- 访客积分/额度检查
- Turnstile 人机验证
- D1 / KV 读写（统计计数、日志）
- 路由分流（根据开关）
- 统一 CORS / 错误处理

ADK Agent 只负责：**生成回答内容**。

---

## 4. 关键决策（已讨论并确定）

| 决策 | 结论 | 原因 |
|------|------|------|
| 部署目标 | **Agent Runtime** | 符合黑客松评分标准，且已确认可用 |
| 试点接口 | **`/api/ask`（实时答疑）** | 接口简单，输入输出清晰，风险低 |
| 前端开关 | 手动 toggle | 用户可选，便于 A/B 对比演示 |
| 认证方式 | 复用现有 Vertex AI 服务账号 | Agent Runtime endpoint 与 Vertex AI 同域名，Worker 已有凭据 |
| Agent Registry | 依赖 Agent Runtime 自动注册 | 部署后会自动出现在 Agent Registry |
| Agent Gateway | 作为 bonus 后续配置 | 当前无 CLI 命令，需手动在 Console 配置 |
| 其他接口（pdf/tutor）| 暂不改 | 先跑通 ask，再考虑扩展 |

---

## 5. 下一个会话需要做的事

### 5.1 本地开发环境

```bash
# 1. 安装 uv（如果还没装）
# https://docs.astral.sh/uv/getting-started/installation/

# 2. 安装 agents-cli
uv tool install google-agents-cli

# 3. 验证安装
agents-cli info
agents-cli --help
```

### 5.2 创建 ADK Ask Agent 项目

在项目根目录下创建：

```bash
cd F:/python_code/AI_reviewer/ver8-moodle-integration
agents-cli scaffold create gpa-buddy-ask-adk \
  --agent adk \
  --deployment-target agent_runtime \
  --region us-west1 \
  --prototype
```

> 注意：
> - 项目名 `gpa-buddy-ask-adk` 必须 ≤ 26 字符，小写字母/数字/连字符
> - 选择 us-west1 是因为当前 Agent Runtime 系统实例也在 us-west1，减少跨区域问题
> - 如果要使用其他 region，先确认 Worker 和 GCS bucket 访问不会受影响

### 5.3 修改 Agent 代码

需要修改 `gpa-buddy-ask-adk/app/agent.py`：

- 定义 root agent
- 系统指令：与现有 `handleAskGemini` 中系统 prompt 一致，强调不剧透答案
- 工具：
  - `get_question_context(question)`：拼接题目上下文
  - 可选：`get_source_page(source)`：从 GCS 读取来源页（如果让 Agent 直接读）
- 输出 schema（Pydantic）：
  - `answer: str`
  - `hint_level: str`（可选）
  - `next_step: str | None`（可选）

参考输入格式（Worker 转发给 Agent）：

```json
{
  "messages": [
    { "role": "user", "text": "为什么选 A？" }
  ],
  "question": {
    "text": "...",
    "options": [{ "key": "A", "text": "..." }],
    "userAnswer": "A",
    "correctAnswer": "B",
    "explanation": "...",
    "source": "file_page3",
    "bankName": "..."
  },
  "images": [
    { "mime_type": "image/png", "data": "base64..." }
  ]
}
```

### 5.4 部署到 Agent Runtime

```bash
cd gpa-buddy-ask-adk
agents-cli deploy --region us-west1
```

注意事项：
- 首次部署可能需要 5-10 分钟
- 如果 CLI 超时，用 `agents-cli deploy --status` 查进度
- 成功后生成 `deployment_metadata.json`，记录 `remote_agent_runtime_id`

### 5.5 修改 Cloudflare Worker

在 `backend/worker.js` 中：

1. 新增环境变量（通过 `wrangler.toml` 或 Cloudflare Dashboard）：

```toml
[vars]
ADK_ASK_ENABLED = "true"
ADK_ASK_REGION = "us-west1"

# secrets（用 wrangler secret put 设置）
# ADK_ASK_RUNTIME_ID = "projects/.../locations/us-west1/reasoningEngines/..."
```

2. 在 `/api/ask` 路由中增加开关判断：

```javascript
if (body.useAdkAgent && env.ADK_ASK_ENABLED === 'true' && env.ADK_ASK_RUNTIME_ID) {
  return forwardToAgentRuntime(request, body, env);
} else {
  return handleAskGemini(request, env);
}
```

3. 实现 `forwardToAgentRuntime()`：
- 复用现有服务账号 JWT 签名（已有 `getAccessToken(env)` 函数）
- 调用 Agent Runtime endpoint：
  `https://us-west1-aiplatform.googleapis.com/reasoningEngines/v1/{RESOURCE_ID}/api/reasoning_engine`
  或 stream 版本 `/api/stream_reasoning_engine`
- 返回 `{ answer: string }` 给前端

### 5.6 前端加开关

在 `practice.html` 或相关问答 UI 中：

```html
<label>
  <input type="checkbox" id="use-adk-agent" />
  使用 ADK Agent 答疑（实验性）
</label>
```

JS 中：

```javascript
const useAdkAgent = document.getElementById('use-adk-agent').checked;
fetch('/api/ask', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Visitor-ID': visitorId },
  body: JSON.stringify({ messages, question, images, useAdkAgent })
});
```

### 5.7 验证 Agent Registry 注册

部署成功后，运行：

```bash
gcloud alpha agent-registry agents list \
  --project gpa-buddy \
  --location us-west1
```

应该能看到 `gpa-buddy-ask-adk` 或类似名称。

### 5.8（可选）配置 Agent Gateway

如果时间允许，在 Console 中：
- 进入 Agent Platform → Gateways
- 把新部署的 Agent  attach 到一个 Gateway
- 配置访问策略

> 注意：Agent Gateway 目前无 `agents-cli` 命令，需要手动在 Console 或 Terraform 中配置。

---

## 6. 已知风险与注意事项

| 风险 | 说明 | 缓解 |
|------|------|------|
| Agent Runtime 部署慢 | 首次 5-10 分钟，可能超时 | 用 `agents-cli deploy --status` 轮询 |
| 不要碰系统实例 | `AGENT_DESIGNER_GENERATED_DO_NOT_DELETE` 是 Agent Platform 自动生成的 | 新建独立 agent，避免修改它 |
| Agent Runtime 请求格式不同 | 不是 `generateContent`，而是 `:streamQuery` 或 FastAPI `/api/reasoning_engine` | 参考 `google-agents-cli-deploy` skill 中 "Agent Runtime Infrastructure" 章节 |
| 区域一致性 | Worker 调用 Vertex 的区域、Agent Runtime 区域、GCS bucket 位置要一致 | 选择 us-west1（与系统实例同区域）|
| 服务账号权限 | 新部署的 Agent Runtime 服务账号需要 `roles/aiplatform.user` 和 `roles/storage.objectViewer` | 部署后检查 IAM |

---

## 7. 有用的参考资料（已安装）

| 文件 | 内容 |
|------|------|
| `.kimi-code/skills/google-agents-cli-workflow/SKILL.md` | 完整开发流程（Phase 0-7）|
| `.kimi-code/skills/google-agents-cli-adk-code/SKILL.md` | ADK Python API 快速参考 |
| `.kimi-code/skills/google-agents-cli-adk-code/references/adk-python.md` | Agent、Tool、State、Workflow 详细示例 |
| `.kimi-code/skills/google-agents-cli-deploy/SKILL.md` | 部署目标对比、Agent Runtime 部署 |
| `.kimi-code/skills/google-agents-cli-deploy/references/agent-runtime.md` | Agent Runtime 架构、endpoint 格式、会话/Artifact 服务 |
| `.kimi-code/skills/google-agents-cli-publish/SKILL.md` | Gemini Enterprise 注册、Agent Registry 管理 |

---

## 8. 快速检查清单（下一个会话开始时）

- [ ] `gcloud config get-value project` 返回 `gpa-buddy`
- [ ] `agents-cli info` 正常输出
- [ ] `gcloud alpha agent-registry agents list --project gpa-buddy --location us-west1` 不报错
- [ ] 确认 Worker 中 `GCP_CLIENT_EMAIL` / `GCP_PRIVATE_KEY` 已配置
- [ ] 确认 GCS bucket `course-materials` 在 us-west1 或可从 us-west1 访问
- [ ] 不要删除 `AGENT_DESIGNER_GENERATED_DO_NOT_DELETE`

---

## 9. 临时备注

- 当前没有写任何代码，仅完成方案讨论、skills 安装和 GCP 环境确认。
- 下个会话的第一个动作建议：运行 `agents-cli scaffold create gpa-buddy-ask-adk ...` 创建本地 ADK 项目骨架。
- 如需立刻开始编码，请新会话中明确说："开始实现 ask 的 ADK Agent"。

### 进度更新（2026-08-02 会话）

已完成：
- [x] `agents-cli` 已安装（v1.2.1）
- [x] `agents-cli scaffold create gpa-buddy-ask-adk --agent adk --deployment-target agent_runtime --region us-west1 --prototype`
- [x] `gpa-buddy-ask-adk/app/agent.py`：答疑助教 agent，系统指令与 `handleAskGemini` 一致；模型 `gemini-2.5-flash-lite`（可用 `ASK_MODEL_ID` 覆盖）；无工具（上下文由 Worker 拼装，与 3.2 数据流一致）；未用 Pydantic 输出 schema（保持 `/api/ask` 返回 `{answer}` 不变）
- [x] `gpa-buddy-ask-adk/.env`：`GOOGLE_CLOUD_PROJECT=gpa-buddy`、`GOOGLE_CLOUD_LOCATION=us-west1`
- [x] `backend/worker.js`：`handleAskGemini` 增加 ADK 分流（`body.useAdkAgent && env.ADK_ASK_ENABLED==='true' && env.ADK_ASK_RUNTIME_ID`），新增 `askViaAgentRuntime()`（复用 `getAccessToken`，调 `:streamQuery`，兼容 JSON 数组/JSONL/SSE 解析）
- [x] `backend/wrangler.toml`：新增 `ADK_ASK_ENABLED="true"`、`ADK_ASK_REGION="us-west1"`（`ADK_ASK_RUNTIME_ID` 待部署后用 `wrangler secret put` 设置）
- [x] `practice.html`：问 Gemini 面板加 `ADK Agent β` 开关（localStorage 键 `askUseAdkAgent`），请求体带 `useAdkAgent`

待办（被阻塞）：
- [ ] ~~本机未安装 gcloud CLI~~ 已通过 winget 安装并登录（charlie2001hhh@gmail.com）

### 部署完成（2026-08-02 会话后半段）

- [x] gcloud CLI 安装 + 登录；**项目 ID 实为 `gpa-490510`（`gpa-buddy` 是显示名）**，`.env` 已同步改
- [x] 开通 `artifactregistry.googleapis.com`、`cloudbuild.googleapis.com`（首次部署失败的根因之一）
- [x] **部署成功**：`agents-cli deploy --region us-west1 --min-instances 0`
  - ⚠️ 关键：`--min-instances 1`（默认）连续 3 次 "failed to start and cannot serve traffic"（镜像构建成功但常驻实例起不来、无任何容器日志）；改 `--min-instances 0` 后一次成功。代价是冷启动，但实测首问仅 ~6s
  - Runtime ID：`projects/933510492864/locations/us-west1/reasoningEngines/5215704930169389056`
- [x] Worker secret `ADK_ASK_RUNTIME_ID` 已设置；`wrangler deploy` 已上线（ADK_ASK_ENABLED=true 生效）
- [x] Agent Registry 自动注册确认：`gpa-buddy-ask-adk` 已在列表中
- [x] 端到端联调通过：`POST /api/ask`（`useAdkAgent:true`）3.1s 返回引导式回答；直连回退链路回归通过
- [ ] **前端 `practice.html` 的 ADK 开关尚未发布**——需按前端静态站点的部署流程发布后才对用户可见
- [ ] （可选）Console 配置 Agent Gateway
- [ ] （可选）稳定后评估是否把 `--min-instances` 调回 1 消除冷启动

### tutor 接口 ADK 化（2026-08-02 会话第三段）

- [x] 新建 `gpa-buddy-tutor-adk`：`SequentialAgent` 工作流 = `skeleton_agent`（gemini-2.5-pro，output_schema 结构化骨架）+ 自定义 `NodeFanoutAgent`（拓扑分批、asyncio 并行、gemini-2.5-flash-lite 逐节点结构化生成 + 重试 + 兜底 stub），以 `tutor_event` JSON 标记事件流式回报进度
- [x] 本地冒烟测试通过（`smoke_test.py`，Runner 直跑，5 节点全流程）；测试 PDF：`gpa-buddy-tutor-adk/test-smoke.pdf`
- [x] Worker：`/api/tutor/generate` 增加 `useAdkAgent` 分流，`runTutorViaAgentRuntime()` 把 `tutor_event` 翻译为既有 SSE 事件类型（**前端协议零改动**）；扣费/complete/GCS 清理两条链路共用
- [x] 前端：`tutor.html` 加 `ADK Agent β` 开关（localStorage `tutorUseAdkAgent`），`tutor-main.js` 提交带 `useAdkAgent`；嵌入页无开关自动走原链路
- [x] **部署在 us-central1**（不是 ask 的 us-west1）：`projects/933510492864/locations/us-central1/reasoningEngines/6229377135409102848`，min-instances=0
- [x] IAM：RE 服务账号获项目级 `roles/storage.objectAdmin`（解决 Cloud Build 读暂存桶 PERMISSION_DENIED）+ 两个 GCS bucket（gpa-buddy-asia / gpa_buddy）的 objectViewer
- [x] Agent Registry（us-central1）确认 `gpa-buddy-tutor-adk` 已注册
- [x] E2E 双链路通过：ADK 链路 35s（骨架 6 节点两批并行），原 Worker 编排链路 43s 回归正常
- 踩坑记录：us-west1 连续失败（零容器日志，疑似区域容量/拉镜像权限）；换 us-central1 后暴露真实错误是 RE 服务账号缺 storage 权限，授 objectAdmin 后一次成功。ask agent 当时在 us-west1 的成功可能也有运气成分
