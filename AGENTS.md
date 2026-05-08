# Agent Instructions

## Project Overview

This is a bilingual (Chinese/English) education/review platform with a Cloudflare Workers backend and vanilla JS frontend.

- **Frontend**: Static HTML + vanilla JavaScript, hosted at project root
- **Backend**: Cloudflare Worker (`backend/worker.js`), D1 database, KV storage
- **Key Features**: Document generation/conversion, AI tutor, OAuth login, voucher system, visitor tracking, file viewer, donation

## Tech Stack

- **Frontend**: HTML5, vanilla JavaScript (ES modules), Tailwind-like CSS via CDN
- **Backend**: Cloudflare Workers, D1 (SQLite), KV
- **Auth**: OAuth (Google/GitHub) + email verification codes
- **APIs**: DeepSeek/OpenAI for AI tutor functionality

## Directory Structure

```
/                    # Frontend pages (HTML + JS)
backend/             # Cloudflare Worker source and migrations
js/                  # Shared frontend JS modules
login/               # OAuth/email auth configs and test accounts
resources/           # Static assets (images, audio, documents)
documents/           # API docs and database schemas
```

## Key Files

| File | Purpose |
|------|---------|
| `index.html` | Main landing page |
| `backend/worker.js` | Cloudflare Worker API (auth, DB, AI proxy) |
| `backend/schema.sql` | D1 database schema |
| `js/tutor-*.js` | AI tutor modules (DB, graph, SSE, panel, main) |
| `js/visitor.js` | Visitor tracking |
| `document-converter.js` | Document format conversion |
| `sw.js` | Service Worker |

## Database

- **D1**: Users, vouchers, email codes, avatars, visitor tracking
- See `backend/schema.sql` and `migration-*.sql` for schema details
- See `documents/d1_DB_voucher.txt` for voucher-specific schema

## Coding Conventions

- Use vanilla JavaScript (no frameworks)
- Frontend JS modules in `js/` use ES module imports
- Worker API routes follow RESTful patterns
- Environment variables: `DEV_MODE`, D1/KV bindings
- Use `console.log` sparingly; prefer structured logging in worker

## Auth Flow

1. OAuth via `oauth-callback.html` → Worker token exchange
2. Email codes via Worker API (6-digit codes, 10-min expiry)
3. JWT-style session management (stored in `localStorage`)

## AI Tutor

- Streaming SSE response from DeepSeek API
- Conversation history stored in D1 (`js/tutor-db.js`)
- Graph visualization via `js/tutor-graph.js`

## Deployment

- Backend: `wrangler deploy` in `backend/`
- Frontend: Static hosting (Cloudflare Pages or similar)
- See `backend/DEPLOY_AUTH.md` for auth deployment notes
