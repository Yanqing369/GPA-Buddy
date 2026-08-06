# 交接文档：GPA Buddy 测验 Agent（Google ADK）

日期：2026-08-06 ｜ 状态：**功能代码完成，待凭证做最终端到端验证**

## 1. 目标回顾

开发一个谷歌 agent（Google ADK, Python），功能对齐 `personal-center.html`：
聊天指令驱动 → 从 Moodle 导入文件（或接受用户上传）→ 调现有 worker 出题 →
用 A2UI 生成测验界面 → 记录错题 → 根据错题再出题，形成循环。
按指导意见：agent 运行时可注册进 Gemini Enterprise，出题交互走 A2UI。实现从简。

## 2. 交付物（本目录 `agent/`）

| 文件 | 说明 |
|---|---|
| `quiz_agent/agent.py` | ADK Agent 定义：gemini-2.5-flash + 中文指令 + 12 个工具 |
| `quiz_agent/tools.py` | worker API 封装：登录检查 / Moodle 列表+导入 / 课程与资料 / 上传 / 出题（SSE）/ 判分+写错题本 / 错题再出题 |
| `quiz_agent/a2ui.py` | A2UI v0.8 风格消息构造（surfaceUpdate 扁平组件邻接表 + beginRendering） |
| `quiz_agent/state.py` | 本地单用户会话状态（JWT / Turnstile / 当前测验）——上云需改为按用户隔离 |
| `server.py` | FastAPI 桥（端口 8788）：静态客户端 + ADK Runner SSE（`/api/chat`）+ `/api/session`（注入 JWT）+ `/api/turnstile` + `/api/upload` |
| `client/index.html` | 极简客户端：聊天 + A2UI 最小渲染器（Text/Column/RadioGroup/Button）+ Google 登录 + Turnstile widget + 文件上传 |
| `docs/gemini-enterprise.md` | 部署到 Agent Engine 并注册进 Gemini Enterprise 的完整步骤（含 curl 与 UI 两种方式） |
| `README.md` | 运行指南 |

运行：`pip install -r requirements.txt` → 配 `GOOGLE_API_KEY`（或 Vertex 环境变量）→ `python server.py` → 打开 http://localhost:8788。

## 3. 已验证（无头测试通过）

- ADK agent 加载正常（12 个工具注册成功）。
- `list_moodle_courses` 调生产 API 成功（返回 2 门课程）。
- SSE 解析器（`_consume_sse_questions`）对 generate-banks / text_generate 的事件格式解析、去重正确。
- 错题再出题链路：`_gen_questions_from_text` 实测成功——`/text_generate` 报错后自动切 `/fallback/pdf_generate`（DeepSeek 通道），返回合法题目 JSON。
- server 全部端点：`/api/status`、`/api/session`（无效 token 正确 401）、`/`、`/api/upload`、`/api/chat`（SSE 管道通畅，错误以结构化事件回传）。
- A2UI 消息结构构造正确。

## 4. 未验证（需要凭证，下一步做）

1. **agent 对话模型**：代码默认 `gemini-2.5-flash`，需要 `GOOGLE_API_KEY`（AI Studio）
   或 Vertex ADC（`gcloud auth application-default login`，本机当前没有 gcloud）。
   备选：`backend/.dev.vars` 里有 `DEEPSEEK_API_KEY`，可用 ADK 的 LiteLLM 临时顶替验证。
2. **worker JWT（登录态）**：生产环境的测试账号后门已关闭（仓库代码里的 `PCG123456`
   在生产返回 Invalid code format，说明线上 worker 与仓库代码不同步）。
   拿 token 两种方式：
   - 打开 http://localhost:8788 点「Google 登录」（顺便验证我们实现的登录链路：
     worker 按 Referer 把 token 302 回 localhost，见 `worker.js getFrontendUrl` :841）；
   - 或登录主站后从 DevTools 复制 `localStorage.auth_token`，在页面里「粘贴 token」。
3. 拿到两者后，按 README 的流程跑一遍完整闭环即完成验收。

## 5. 重要发现：worker 生产 bug（建议修复）

**线上文本出题全挂**。`worker.js:3278` `streamVertexFromText` 给 `gemini-2.5-flash-lite`
发送了 `thinkingConfig: {thinkingLevel: 'LOW'}`，该模型只认 `thinkingBudget` 不认
`thinkingLevel`（那是新版模型的参数），Vertex 返回 400：
`thinking_level is not supported by this model`。

影响面：`/text_generate`、`/api/courses/{id}/generate-banks` 的文本资料路径全部报错；
`/pdf_generate` 走 `streamVertex`（`thinkingBudget: -1`，:3241）理论上不受此影响。
DeepSeek fallback 接口（`/fallback/pdf_generate`）正常——agent 的错题再出题已利用它兜底。

修复建议：`thinkingLevel: 'LOW'` 改为 `thinkingBudget: 1024`（或直接删掉 thinkingConfig）。

## 6. 其他关键结论

- **Turnstile**：生产 worker 未强制校验（实测不带 token 也能进到出题环节）。
  客户端仍内嵌了 widget（sitekey 同主站 `0x4AAAAAACyCQq1B6IXFL27N`），将来开启强制校验可无缝衔接。
- **错题本**没有专用接口：是 `bank_type='mistake'` 的 cloud bank。读 = `POST /api/share/{id}/download`
  （owner 免密），写 = `PUT /api/cloud-banks/{id}/content`（整包 JSON 写回）。
  错题计数沿用主站惯例：`source` 后缀 ` [N-times mistake]`。
- **Moodle 导入**两步：`GET /api/moodle/courses`（免登录）→ `POST /api/moodle/courses/{id}/import`（需登录）。
- **出题扣费**：generate-banks 每个文件扣 1 点额度，测试时注意。
- **A2UI**：agent 的 `present_quiz` 工具返回 `a2ui_messages`，server 桥识别后推给客户端渲染；
  作答以 `[QUIZ_ANSWERS]{json}` 消息回传，agent 解析后调 `grade_quiz`。
  GE 若不渲染 A2UI，退化为纯文本交互，流程不变。
- **敏感文件**：`login/oauth.json`、`backend/.dev.vars`、`login/test_accounts.txt`、
  `api-test.py.local` 含密钥，勿提交（`api-test.py.local` 目前未被 git 跟踪，保持如此）。

## 7. 继续工作的入口

1. 配好 `GOOGLE_API_KEY` + 浏览器登录拿 JWT（见第 4 节）。
2. 跑闭环：列出 Moodle 课程 → 导入 → 出题 → 作答 → 查错题 → 错题再出题。
3. 修 worker 的 thinkingLevel bug（第 5 节）后，文本资料出题链路恢复。
4. 按 `docs/gemini-enterprise.md` 部署注册到 Gemini Enterprise。
