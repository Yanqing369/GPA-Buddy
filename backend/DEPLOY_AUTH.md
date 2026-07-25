# 登录系统部署指南

## 概述

已为您实现基于 Google OAuth 的登录系统。

**重要：域名配置**
- 前端网站：`https://www.gpa-buddy.com`
- Worker API：`https://moyuxiaowu.org`
- Google OAuth 流程：前端 → Worker → Google → Worker → 前端

## 部署前检查清单

### 1. Google Cloud Console 配置更新

您需要更新 Google OAuth 的回调地址配置：

访问 [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → 您的 OAuth 客户端 → 修改 → **授权的重定向 URI**：

```
https://moyuxiaowu.org/auth/google/callback
```

**注意：** 回调地址是 Worker 的域名（moyuxiaowu.org），不是前端域名（gpa-buddy.com）

### 2. 已配置的环境变量

`wrangler.toml` 中已添加：
```toml
[vars]
FRONTEND_URL = "https://www.gpa-buddy.com"
```

### 3. 需要设置的 Secrets

```bash
# 1. JWT 密钥（随机字符串，用于签名登录 Token）
npx wrangler secret put JWT_SECRET
# 输入: 随机字符串，如: your-secret-key-123456789

# 2. Google OAuth 客户端 ID（如果还没设置）
npx wrangler secret put GOOGLE_CLIENT_ID
# 输入: 933510492864-26bo4qbuul0etd7boequap5v8sfpghfj.apps.googleusercontent.com

# 3. Google OAuth 客户端密钥（如果还没设置）
npx wrangler secret put GOOGLE_CLIENT_SECRET
# 输入: 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
```

### 4. 部署 Worker

```bash
npx wrangler deploy
```

## 登录流程

```
1. 用户访问 https://www.gpa-buddy.com
   ↓
2. 点击"登录"按钮
   ↓
3. 跳转到 https://moyuxiaowu.org/auth/google
   ↓
4. Worker 生成 Google OAuth URL，回调地址是 moyuxiaowu.org
   ↓
5. Google 授权页面
   ↓
6. Google 回调到 https://moyuxiaowu.org/auth/google/callback
   ↓
7. Worker 处理登录，生成 JWT Token
   ↓
8. Worker 跳转回 https://www.gpa-buddy.com/index.html?login=success&token=xxx
   ↓
9. 前端读取 token，存储到 localStorage，显示登录状态
```

## 故障排除

### 登录后显示 "Not found"

原因：Google 回调 URI 配置错误

解决：
1. 检查 Google Cloud Console 中的回调 URI 是否为 `https://moyuxiaowu.org/auth/google/callback`
2. 检查 Worker 是否正确部署

### 登录后停留在 moyuxiaowu.org

原因：FRONTEND_URL 环境变量未生效

解决：
1. 确认 `wrangler.toml` 中有 `[vars]` 部分的 `FRONTEND_URL`
2. 重新部署：`npx wrangler deploy`

### 其他问题

查看 Worker 日志：
```bash
npx wrangler tail
```

## API 端点

| 端点 | 描述 |
|------|------|
| `GET /auth/google` | 开始 Google 登录 |
| `GET /auth/google/callback` | Google 回调处理 |
| `GET /auth/me` | 获取当前用户信息 |
| `POST /auth/logout` | 退出登录 |
| `GET /api/balance` | 获取余额和额度 |
| `GET /api/banks` | 获取题库列表 |
| `POST /api/banks` | 创建题库 |
