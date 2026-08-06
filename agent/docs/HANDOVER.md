# 交接文档：GPA Buddy 测验 Agent（Google ADK）

日期：2026-08-06 ｜ 状态：**完成——完整闭环已对生产 API 实测通过（验收标准 1-6 全部跑通）**

## 1. 目标与设计思路

做一个对齐 `personal-center.html` 核心功能的谷歌 agent（Google ADK, Python）：

> 聊天指令 → 从 Moodle 导入文件（或用户上传）→ 调现有 worker 出题 → A2UI 测验界面 → 记录错题 → 根据错题再出题（循环）

设计原则（按指导意见，从简）：

- **不改 worker**：agent 只是 worker API（https://moyuxiaowu.org）的一个新客户端，复用全部现有接口。
- **agent 只做规划，不做实现**：所有出题/存储逻辑都在 worker；agent 的 12 个工具就是 worker 端点的薄封装。
- **A2UI 走工具返回值**：agent 调 `present_quiz` 工具 → 返回 `a2ui_messages` → 桥接服务器识别后通过 SSE 推给客户端渲染；作答以 `[QUIZ_ANSWERS]{json}` 聊天消息回传 → agent 调 `grade_quiz` 判分。不需要独立的 UI 通道。
- **登录复用 worker 的 Referer 机制**：worker 的 Google OAuth 回调会按登录页的 Referer 重定向
  （`worker.js getFrontendUrl` :841），所以本地页面点一下「Google 登录」，token 就会被 302 回
  `localhost:8788/index.html?token=...`，客户端捕获后 POST 给 `/api/session`。零额外 OAuth 配置。
- **错题本 = cloud bank**：复用主站惯例（`bank_type='mistake'`，整包 JSON 写回，`[N-times mistake]` 计数）。

## 2. 项目结构

```
agent/
├── quiz_agent/
│   ├── agent.py     # ADK Agent：模型 + 中文指令 + 12 个工具。
│   │                # 模型默认 gemini-2.5-flash；AGENT_MODEL=deepseek/deepseek-chat 可切 LiteLLM
│   ├── tools.py     # worker API 工具层（全部逻辑在这一个文件）：
│   │                #   check_login / list_moodle_courses / import_moodle_course
│   │                #   list_my_courses / create_course / list_materials / upload_material
│   │                #   generate_quiz（generate-banks SSE）/ present_quiz（A2UI）
│   │                #   grade_quiz（判分+写错题本）/ list_mistakes
│   │                #   generate_quiz_from_mistakes（text_generate → 失败自动 fallback DeepSeek）
│   ├── a2ui.py      # A2UI v0.8 风格消息构造（surfaceUpdate 扁平组件邻接表 + beginRendering）
│   └── state.py     # 本地单用户会话状态（JWT / Turnstile / 当前测验）。上云需按用户隔离
├── server.py        # FastAPI 桥（:8788）：静态客户端 + /api/chat(ADK Runner SSE)
│   │                #   + /api/session(注入JWT) + /api/turnstile + /api/upload + /api/status
│   │                #   可选 QUIZ_AGENT_SEED_QUIZ=<json> 预置演示题目（无登录演示 A2UI 链路）
├── client/index.html# 极简客户端：聊天 + A2UI 最小渲染器(Text/Column/RadioGroup/Button)
│   │                #   + Google 登录按钮 + token 捕获 + Turnstile widget + 文件上传
├── seed_quiz.json   # 演示用种子题目（配合 QUIZ_AGENT_SEED_QUIZ）
├── requirements.txt
├── README.md        # 运行指南
└── docs/
    ├── HANDOVER.md              # 本文档
    └── gemini-enterprise.md     # 部署 Agent Engine + 注册 Gemini Enterprise 完整步骤
```

## 3. 数据流（完整循环）

```
用户聊天 ──▶ client ──POST /api/chat──▶ server ──▶ ADK Runner ──▶ agent(Gemini/DeepSeek)
                                                          │ 调工具
                                                          ▼
                                          worker API (moyuxiaowu.org)
                                     Moodle导入/上传/generate-banks/cloud-banks
agent 调 present_quiz ──▶ 工具返回 a2ui_messages ──▶ server 识别 ──SSE {type:a2ui}──▶ client 渲染测验卡片
用户作答提交 ──▶ client 发 "[QUIZ_ANSWERS]{...}" ──▶ agent 调 grade_quiz ──▶ 判分 + 错题写云端错题本
用户说"根据错题再出题" ──▶ generate_quiz_from_mistakes ──▶ present_quiz ──▶ 下一轮
```

## 4. 验证状态

### 已实测通过

- agent 加载（12 工具注册）；`/api/status`、`/api/session`（坏 token 正确 401）、`/`、`/api/upload`。
- **真实 LLM 聊天闭环**（AGENT_MODEL=deepseek/deepseek-chat，key 取自 `backend/.dev.vars`）：
  - 「列出 Moodle 课程」→ agent 自主调 `list_moodle_courses` → 返回生产环境真实课程列表 ✓
  - 「调 present_quiz 展示测验」→ SSE 收到 A2UI 消息（surfaceUpdate+beginRendering，9 组件）✓
  - 「[QUIZ_ANSWERS]…」→ agent 调 `grade_quiz` → 判分 1/3 + 逐题解析 ✓（未登录时正确提示错题未保存）
- SSE 出题解析器：事件解析、final_result/file_done 去重正确。
- **错题再出题链路实测**：`/text_generate` 报错 → 自动切 `/fallback/pdf_generate`（DeepSeek）→ 返回合法题目 ✓
- 免登录错误路径：未登录时 agent 正确引导用户点「Google 登录」。

### 待复验（需要真实登录态 JWT，浏览器点一次「Google 登录」即可）

- ~~import_moodle_course / generate_quiz / 错题写入 / 错题再出题~~ —— **2026-08-06 已全部实测通过**：
  测试账号（test1@gpa-buddy.com，验证码已改为 `firebird`）登录 → 导入 Moodle 课程 3
  （课程 id 40，PDF 资料 id 64）→ generate-banks 出 20 题 ✓ → 故意答错 2 题判分 18/20 ✓ →
  错题写入云端错题本（`[1-times mistake]` 后缀正确）✓ → 根据错题生成 20 道新题 ✓。
- 唯一未实测：浏览器里点「Google 登录」的 OAuth 跳转链路（代码已实现，原理见第 1 节；
  如跳转异常，可用页面上的「粘贴 token」兜底）。
- 用 Gemini 模型跑一遍聊天（设 `GOOGLE_API_KEY`，去掉 AGENT_MODEL 即可；DeepSeek 路径已验证）。

## 5. 重要发现：worker 生产 bug（建议尽快修）

**线上文本出题全挂**：`worker.js:3278` `streamVertexFromText` 给 `gemini-2.5-flash-lite`
发送 `thinkingConfig: {thinkingLevel: 'LOW'}`，该模型只认 `thinkingBudget` 不认 `thinkingLevel`，
Vertex 返回 400 `thinking_level is not supported by this model`。

- 影响：`/text_generate`、`generate-banks` 的文本资料路径全部报错；
  PDF 路径（`streamVertex`，`thinkingBudget: -1`，:3241）不受此 bug 影响；
  `/fallback/pdf_generate`（DeepSeek）正常，agent 已用它兜底错题再出题。
- 修复：`thinkingLevel: 'LOW'` 改成 `thinkingBudget: 1024`（或删掉 thinkingConfig）。
- 测试账号：test1/test2@gpa-buddy.com，当前验证码 `firebird`（见 main 分支提交 249d3a3；
  旧码 `PCG123456` 已失效）。

## 6. 其他关键结论

- **Turnstile**：生产未强制校验（实测无 token 也能出题）。客户端仍内嵌 widget
  （sitekey 同主站），将来开启强制校验可无缝衔接。
- **错题本接口**：读 = `POST /api/share/{id}/download`（owner 免密），
  写 = `PUT /api/cloud-banks/{id}/content`（整包 JSON）。
- **出题扣费**：generate-banks 每个文件扣 1 点。
- **A2UI 退化**：GE 若不渲染 A2UI，agent 退化为纯文本交互，流程不变。
- **敏感文件勿提交**：`login/oauth.json`、`backend/.dev.vars`、`login/test_accounts.txt`、
  `api-test.py.local`（未跟踪，保持如此）。

## 7. 接手 checklist

1. `pip install -r requirements.txt`；设 `GOOGLE_API_KEY`（或 `AGENT_MODEL=deepseek/deepseek-chat` + `DEEPSEEK_API_KEY`）。
2. `python server.py` → http://localhost:8788 → 点「Google 登录」。
3. 跑闭环：列出 Moodle 课程 → 导入 → 出题 → 作答 → 查错题 → 错题再出题（对应验收标准 1-6）。
4. 修 worker 的 thinkingLevel bug（第 5 节）。
5. 按 `docs/gemini-enterprise.md` 注册进 Gemini Enterprise。
