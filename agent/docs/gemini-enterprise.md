# 将测验 Agent 注册到 Gemini Enterprise

本文档说明如何把本项目的 ADK 测验 agent 部署到 Vertex AI Agent Engine，并注册进
Gemini Enterprise（原 Agentspace），使其成为 GE 生态中可直接使用的 agent。

整体路径：**ADK agent → 部署到 Agent Engine → 在 Gemini Enterprise 中注册 → 用户在 GE 应用中使用**。

---

## 0. 前提条件

- 一个 Google Cloud 项目，已启用以下 API：
  - Vertex AI API（`aiplatform.googleapis.com`）
  - Discovery Engine API（`discoveryengine.googleapis.com`，Gemini Enterprise 底层使用）
- 已开通 Gemini Enterprise（需要一个 GE app / engine，记下 `APP_ID`）。
- 本机已安装并登录 `gcloud`（`gcloud auth login` + `gcloud config set project PROJECT_ID`）。
- 权限：
  - 注册 agent 需要 `agents.manage`（通常包含在 **Discovery Engine Admin** 角色中）。
  - GE 的 discoveryengine 服务账号需要 **Vertex AI User** 和 **Vertex AI Viewer** 角色，
    否则 GE 无法调用 Agent Engine 上的 agent。
- 本目录下 agent 代码可本地运行（见 `../README.md`）。

## 1. 部署 agent 到 Vertex AI Agent Engine

在 `agent/` 目录（包含 `quiz_agent/` 包）下执行标准部署（不要用 accelerated 方式）：

```bash
adk deploy agent_engine \
  --project=PROJECT_ID \
  --region=us-central1 \
  --staging_bucket=gs://YOUR_STAGING_BUCKET \
  quiz_agent
```

或使用 Python API（`vertexai.agent_engines.AdkApp`）部署，二者等价。

部署成功后记下 reasoning engine 资源名：

```
projects/PROJECT_ID/locations/REGION/reasoningEngines/AE_RESOURCE_ID
```

> 注意：本 agent 的工具会调用外部 worker API（https://moyuxiaowu.org）。
> Agent Engine 环境默认可以访问公网；登录态（worker JWT）存在 ADK 会话 state
> （`tool_context.state`，按会话隔离），目前由本地客户端经 server.py 注入，
> 部署到云端后需要改为每个用户各自的 token 注入方式
> （例如通过 GE 的 OAuth authorizations，见下文第 2 步）。

## 2. （可选）配置 OAuth Authorization

如果 agent 需要代表用户调用需登录的接口，在 GE 侧配置 OAuth：

**关键**：必须把下面这个回调地址加到你的 OAuth 应用的 Allowed Redirect URIs：

```
https://vertexaisearch.cloud.google.com/oauth-redirect
```

创建 authorization 资源：

```bash
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: PROJECT_ID" \
  "https://discoveryengine.googleapis.com/v1alpha/projects/PROJECT_ID/locations/global/authorizations?authorizationId=AUTH_ID" \
  -d '{
    "name": "projects/PROJECT_ID/locations/global/authorizations/AUTH_ID",
    "serverSide0auth2": {
      "clientId": "OAUTH_CLIENT_ID",
      "clientSecret": "OAUTH_CLIENT_SECRET",
      "authorizationUri": "https://accounts.google.com/o/oauth2/v2/auth",
      "tokenUri": "https://oauth2.googleapis.com/token"
    }
  }'
```

agent 代码中可通过 `tool_context.state[f"temp:{AUTH_ID}"]` 拿到用户的 access token。

## 3. 注册 agent 到 Gemini Enterprise

### 方式 A：API（curl）

```bash
curl -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -H "X-Goog-User-Project: PROJECT_ID" \
  "https://discoveryengine.googleapis.com/v1alpha/projects/PROJECT_ID/locations/global/collections/default_collection/engines/APP_ID/assistants/default_assistant/agents" \
  -d '{
    "displayName": "GPA Buddy 测验 Agent",
    "description": "从 Moodle 导入课程资料或接受文件上传，自动生成选择题测验，记录错题并针对错题再出新题。",
    "adk_agent_definition": {
      "tool_description": "当用户想要：从 Moodle 导入课件/资料生成测验题、做选择题练习、查看错题本、或根据错题重新出题时，使用此 agent。",
      "provisioned_reasoning_engine": {
        "reasoning_engine": "projects/PROJECT_ID/locations/REGION/reasoningEngines/AE_RESOURCE_ID"
      },
      "authorizations": [
        "projects/PROJECT_ID/locations/global/authorizations/AUTH_ID"
      ]
    }
  }'
```

（不需要 OAuth 时去掉 `authorizations` 字段。）

### 方式 B：UI（更简单，推荐先手动验证）

1. 打开 Gemini Enterprise App 页面 → 左侧 **Agents** → **+ Add agent**。
2. 选择 **Custom agent via Agent Engine** → Add。
3. （可选）配置 Authorizations：填 Client ID / Secret / Token URI / Authorization URI。
4. 填 Agent name、Agent description（这是编排层 LLM 做意图路由的依据，要写清适用场景）、
   Agent Engine reasoning engine 的完整资源路径。
5. Create，确认 agent 状态为 **Enabled**。

## 4. 验证

1. Google Cloud Console → Gemini Enterprise → 选择你的 App。
2. **Integration** 菜单里打开 **Enable the Web App**。
3. 点击 Web App 链接，左侧 Agents 列表中应能看到「GPA Buddy 测验 Agent」。
4. 与它对话：先让它列出 Moodle 课程，再导入、出题、做题。

## 5. A2UI 说明

本 agent 的出题交互通过 A2UI 协议消息（`surfaceUpdate` / `beginRendering` 等）描述测验界面，
本地演示客户端（`client/index.html`）实现了最小渲染器。GE 对 A2UI 的原生渲染支持取决于
GE 版本；若当前 GE 版本不渲染 A2UI 消息，agent 在 GE 中会退化为纯文本交互
（工具仍返回题目的文本摘要，用户用文字作答，流程不变）。

## 6. 常见问题

- **Session initialization failed**：Agent Engine runtime 与 google-adk 版本兼容性问题，
  尝试升级/降级 `google-adk`（已知 1.23/1.24 曾有回归）。
- **GE 调用 agent 报权限错误**：检查 discoveryengine 服务账号是否有 Vertex AI User 角色。
- **更新 agent**：用 PATCH 请求，且必须带上 `displayName`、`description`、
  `tool_description`、`reasoning_engine` 全部字段（即使没改）。

参考：
- [Registering ADK Agents on Vertex AI Agent Engine in Gemini Enterprise](https://www.cloudbabble.co.uk/2025-12-08-Registering-ADK-Agents-On-Vertex-AI-Agent-Engine-In-Gemini-Enterprise/)
- [ADK 官方部署文档](https://google.github.io/adk-docs/deploy/agent-engine/)
