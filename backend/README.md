# Cloudflare Worker 后端部署指南

## 功能

这个 Worker 替换了原来的 Python FastAPI 后端，提供以下接口：

- `GET /ping` - 健康检查
- `GET /stats` - 获取全局统计信息（生成次数）
- `POST /chat` - 单条 LLM 对话 (DeepSeek)
- `POST /chat/batch` - 批量 LLM 对话（并发）(DeepSeek)
- `POST /generate-with-file` - 使用 Kimi API 上传 PDF 并生成题目

## 部署步骤

### 1. 安装 Wrangler CLI

```bash
npm install -g wrangler
```

### 2. 登录 Cloudflare

```bash
wrangler login
```

### 3. 创建 KV 命名空间

**Wrangler 3.60.0+ 版本（新语法）：**
```bash
npx wrangler kv namespace create EXAM_STATS
```

**旧版本（如上述命令报错）：**
```bash
npx wrangler kv:namespace create "EXAM_STATS"
```

执行后会返回类似：
```
🌀 Creating namespace with title "autumn-fire-bc81-EXAM_STATS"
✨ Success!
Add the following to your configuration file:
[[kv_namespaces]]
binding = "EXAM_STATS"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 4. 更新 wrangler.toml

将上一步得到的 id 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "EXAM_STATS"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # 你的 KV ID
```

### 5. 设置环境变量（API Key）

```bash
# 设置 DeepSeek API Key（用于传统文本生成）
wrangler secret put DEEPSEEK_API_KEY

# 设置 Moonshot API Key（用于PDF多模态生成）
wrangler secret put MOONSHOT_API_KEY
```

注意：两个 API Key 都是必需的。DEEPSEEK_API_KEY 用于原有的文本生成功能，MOONSHOT_API_KEY 用于新的 PDF 多模态生成功能。

### 6. 部署

```bash
wrangler deploy
```

部署成功后，Worker 将在 `https://autumn-fire-bc81.charlie2001hhh.workers.dev` 运行。

## 验证部署

```bash
curl https://autumn-fire-bc81.charlie2001hhh.workers.dev/ping
# 应该返回: {"status":"pong"}
```

## 更新前端

部署成功后，前端代码已配置为使用新的 Worker 地址：
- `index.html`
- `generate.html`
- `organize.html`

所有页面的 `API_BASE` 已更新为 Worker 地址。

## 故障排除

### 1. wrangler 命令找不到
确保已全局安装：`npm install -g wrangler`
或使用 npx：`npx wrangler <command>`

### 2. KV 命令报错
Wrangler 3.60.0+ 版本语法有变化：
- ✅ 新语法：`wrangler kv namespace create EXAM_STATS`
- ❌ 旧语法：`wrangler kv:namespace create "EXAM_STATS"`

### 3. 部署后 /stats 返回 0
需要先在 KV 中初始化计数：
```bash
npx wrangler kv key put --binding=EXAM_STATS "total_count" "0"
```
