# GPA Buddy 测验 Agent（Google ADK）

一个基于 Google ADK (Python) 的测验 agent：用聊天指令驱动，完成
**Moodle 导入 / 文件上传 → 调 worker 出题 → A2UI 测验界面作答 → 记录错题 → 根据错题再出题**
的完整循环。后端复用现有 Cloudflare Worker（https://moyuxiaowu.org），不改动 worker。

```
agent/
├── quiz_agent/
│   ├── agent.py     # ADK Agent 定义（模型 + 指令 + 工具）
│   ├── tools.py     # worker API 工具：登录检查/Moodle/上传/出题SSE/错题本/错题再出题
│   ├── a2ui.py      # A2UI v0.8 风格消息构造（surfaceUpdate + beginRendering）
│   └── state.py     # 本地单用户会话状态（token / turnstile / 当前测验）
├── server.py        # FastAPI 桥：静态客户端 + ADK Runner SSE + 登录/上传/Turnstile 端点
├── client/index.html# 极简客户端：聊天 + A2UI 渲染 + Google 登录 + Turnstile
├── docs/gemini-enterprise.md  # 部署到 Agent Engine 并注册进 Gemini Enterprise 的指南
└── requirements.txt
```

## 准备

1. Python 3.10+，安装依赖：
   ```bash
   pip install -r requirements.txt
   ```
2. 配置 agent 大模型的密钥（二选一）：
   ```bash
   # AI Studio API key
   set GOOGLE_API_KEY=你的key          # Windows
   export GOOGLE_API_KEY=你的key       # bash
   ```
   或使用 Vertex AI：`GOOGLE_GENAI_USE_VERTEXAI=TRUE` + `GOOGLE_CLOUD_PROJECT` + `gcloud auth application-default login`。
   也可临时用 DeepSeek 验证：`set AGENT_MODEL=deepseek/deepseek-chat` + `set DEEPSEEK_API_KEY=...`。

## 运行

```bash
python server.py
```

浏览器打开 **http://localhost:8788**。

## 使用流程

1. 点右上角 **「Google 登录」**——会打开 worker 的 Google OAuth，登录后自动跳回本地页面并注入 JWT
   （原理：worker 按 Referer 把 token 重定向回 localhost，见 `worker.js getFrontendUrl`）。
   也可以点「粘贴 token」直接粘入前端 localStorage 里的 `auth_token`。
2. 聊天指令示例：
   - `列出 Moodle 课程` → `导入第 2 门课并出 10 道题`
   - 或点「上传文件」选择本地 PDF/TXT/MD
3. agent 出题后，页面里会出现 **A2UI 渲染的测验卡片**，选完点「提交答案」。
4. 判分后错题自动写入云端错题本（bank_type='mistake' 的 cloud bank）。
5. 说 `根据错题再出一套题`，进入下一轮循环。

## 说明与已知限制

- **Turnstile**：客户端页面内嵌了 Turnstile widget（sitekey 与主站相同），拿到 token 就推给服务端；
  目前生产 worker 未强制校验（`TURNSTILE_SECRET_KEY` 未配置），没有 token 也能出题；
  若将来 worker 开启强制校验，widget 会自动补上。
- **worker 故障兜底**：`/text_generate` 依赖的 Vertex 当前配置异常会直接报错，
  错题再出题会自动改走 `/fallback/pdf_generate`（DeepSeek 通道）。
- 出题会消耗账号额度（每个文件 1 点）。
- 上传给 agent 的文件仅支持 `.pdf / .txt / .md`（主站的 Office→PDF 转换是浏览器端做的，这里从简）。
- 这是本地单用户演示：`state.py` 用模块级状态存 token 与当前测验，部署到云端需按用户隔离。
- 注册进 Gemini Enterprise / Agent Engine 的步骤见 `docs/gemini-enterprise.md`。
