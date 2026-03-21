# GPA4.0 智能刷题助手 - AI Coding Agent Guide

## Project Overview

**GPA4.0 智能刷题助手** (Smart Exam Assistant) is a web application that helps students generate practice question banks from study materials using AI. Users can upload PDF, Word, PPT, and Excel files, and the AI will automatically extract content to generate standardized question banks with explanations.

### Key Features
- **AI-Powered Generation**: Upload study materials (PDF, Word, PPT, Excel) to auto-generate question banks
- **Question Bank Management**: View, practice, export, and import JSON question banks
- **Practice Mode**: Interactive practice with scoring, explanations, and source file reference
- **Multi-Language Support**: 简体中文 (Simplified Chinese), 繁體中文 (Traditional Chinese), English, 한국어 (Korean)
- **Privacy-First**: All data stored locally in browser (IndexedDB) - no server-side data persistence
- **Source File Viewer**: View original documents while practicing to verify answers

## Project Structure

```
project-root/
├── index.html          # Homepage - main navigation and recent items
├── generate.html       # Generate question banks from uploaded files
├── organize.html       # Convert messy question formats to standard JSON
├── manage.html         # Question bank management (CRUD operations)
├── practice.html       # Practice mode with quiz interface
├── fileViewer.js       # Shared utility for viewing PDF/Word/Excel/PPT files
├── AGENTS.md           # This file - project documentation for AI agents
└── backend/            # Backend services
    ├── backend.py      # Python FastAPI backend (alternative/local dev)
    ├── config.py       # API key configuration for Python backend
    ├── worker.js       # Cloudflare Worker backend (production)
    ├── wrangler.toml   # Cloudflare Worker configuration
    ├── README.md       # Backend deployment guide
    └── count.txt       # Stats counter (for Python backend)
```

## Technology Stack

### Frontend
- **HTML5 + Vanilla JavaScript**: No framework, pure browser-native JS
- **Tailwind CSS**: Utility-first CSS framework (loaded from CDN)
- **Dexie.js**: IndexedDB wrapper for client-side database
- **PDF.js**: PDF file parsing and rendering
- **Mammoth.js**: Word document (.docx) parsing
- **XLSX.js**: Excel file parsing
- **JSZip**: PPT and ZIP file handling

### Backend
- **Cloudflare Worker**: Production backend (JavaScript/ES6)
- **Python FastAPI**: Alternative backend for local development
- **DeepSeek API**: LLM service for AI-powered content generation

### Data Storage
- **IndexedDB**: Client-side database for question banks and practice progress
- **Cloudflare KV**: Global statistics counter only
- **localStorage**: User preferences (language, settings)

## Architecture

### Frontend Architecture
The frontend is a Single Page Application (SPA) without a framework:

1. **Page Structure**:
   - Each HTML file is a separate page with shared navigation
   - Common patterns: Navigation bar, language dropdown, settings modal

2. **Database Schema** (IndexedDB via Dexie):
   ```javascript
   db.version(3).stores({
       questionBanks: '++id, name, createdAt, updatedAt',
       practiceProgress: '++id, bankId, lastPracticeAt',
       sourceFiles: '++id, name, bankId, data, createdAt',
       settings: 'key'
   });
   ```

3. **Internationalization**:
   - Translation dictionaries defined in each page
   - `data-i18n` attributes for translatable elements
   - `currentLang` stored in localStorage

### Backend Architecture

#### Cloudflare Worker (Production)
- Entry point: `worker.js`
- Routes:
  - `GET /ping` - Health check
  - `GET /stats` - Global generation counter
  - `POST /chat` - Single LLM call
  - `POST /chat/batch` - Batch concurrent LLM calls

#### Python FastAPI (Local Development)
- Entry point: `backend.py`
- Same API structure as Worker
- File-based counter (`count.txt`)

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ping` | GET | Health check - returns `{"status": "pong"}` |
| `/stats` | GET | Get global generation count |
| `/chat` | POST | Single DeepSeek API call |
| `/chat/batch` | POST | Batch concurrent DeepSeek API calls |

### Request/Response Format

**POST /chat**:
```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ]
}
```

**POST /chat/batch**:
```json
{
  "items": [
    {"chunk_id": 1, "messages": [...]},
    {"chunk_id": 2, "messages": [...]}
  ]
}
```

## Development Guidelines

### Code Style
- **Comments**: Primarily in Chinese (简体中文)
- **Naming**: camelCase for JavaScript, snake_case for Python
- **Indentation**: 4 spaces
- **Quotes**: Double quotes for HTML attributes, single/double for JS strings

### File Processing
The app supports extracting text from:
- **PDF**: Using PDF.js - extracts text content page by page
- **Word (.docx)**: Using Mammoth.js - converts to HTML/text
- **Excel (.xlsx)**: Using XLSX.js - reads all sheets
- **PPT (.pptx)**: Using JSZip - parses XML structure

### AI Prompt Engineering
The app uses structured prompts to generate standardized JSON output:
```json
{
  "questions": [
    {
      "id": 1,
      "type": "single_choice",
      "question": "...",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "answer": "A",
      "explanation": "...",
      "source": {"page": 1, "paragraph": 2}
    }
  ]
}
```

### Configuration

**Backend Configuration**:
- Cloudflare Worker: Environment variables via `wrangler secret put DEEPSEEK_API_KEY`
- Python backend: Hardcoded in `backend/config.py`

**Frontend Configuration**:
```javascript
const API_BASE = "https://your-worker-url.workers.dev";  // Backend URL
const DB_NAME = 'ExamBuddyDB_Clean_v2';                  // IndexedDB name
```

## Build and Deployment

### No Build Process
This project has **no build step**. All files are served as static assets:
- Frontend: Serve HTML/JS files directly from any static web server
- Backend: Deploy Worker or run Python script

### Deployment Options

**Option 1: Cloudflare Pages + Worker (Recommended)**
1. Deploy frontend to Cloudflare Pages (or any static hosting)
2. Deploy `backend/worker.js` to Cloudflare Workers
3. Set environment variable: `DEEPSEEK_API_KEY`

**Option 2: Python Backend (Local/Server)**
1. Install dependencies: `pip install fastapi httpx uvicorn`
2. Run: `uvicorn backend.backend:app --reload`

**Option 3: Static Files Only**
- Frontend can run entirely client-side (no backend required for local-only usage)
- AI features require backend connection

### Backend Deployment Steps

See `backend/README.md` for detailed instructions.

Quick deploy to Cloudflare Worker:
```bash
cd backend
npm install -g wrangler
wrangler login
npx wrangler kv namespace create EXAM_STATS
# Update wrangler.toml with KV namespace ID
wrangler secret put DEEPSEEK_API_KEY
wrangler deploy
```

## Testing

### Manual Testing Checklist
- [ ] Upload PDF/Word/Excel/PPT files and verify text extraction
- [ ] Generate question bank and verify JSON format
- [ ] Practice mode - answer questions, check scoring
- [ ] Source file viewer - verify PDF/Word/PPT/Excel rendering
- [ ] Language switching - verify all translations
- [ ] Export/Import JSON - verify data integrity

### Browser Compatibility
- Chrome/Edge (recommended)
- Firefox
- Safari (limited testing)
- Mobile browsers (responsive design)

## Security Considerations

1. **API Keys**: 
   - Never commit API keys to version control
   - Use environment variables or `wrangler secret`
   - Python `config.py` contains a hardcoded key - **CHANGE THIS**

2. **CORS**:
   - Worker/backend configured to allow all origins (`*`)
   - For production, restrict to your domain

3. **Data Privacy**:
   - User data stored locally in browser
   - File contents processed client-side before AI upload
   - No persistent server-side storage of user content

4. **XSS Prevention**:
   - User content rendered with textContent where possible
   - HTML content from Word files sanitized via Mammoth

## Troubleshooting

### Common Issues

1. **Database errors**: 
   - Use settings modal → "Reset Database" button
   - Or clear browser IndexedDB manually

2. **File parsing fails**:
   - Check file format (must be .pdf, .docx, .xlsx, .pptx)
   - Try smaller files first
   - Check browser console for errors

3. **API call fails**:
   - Verify `API_BASE` URL in frontend code
   - Check backend `/ping` endpoint
   - Verify DeepSeek API key validity

4. **Stats showing 0**:
   - For Python backend: ensure `count.txt` exists
   - For Worker: initialize KV: `npx wrangler kv key put --binding=EXAM_STATS "total_count" "0"`

## Environment Variables

### Required
| Variable | Description | Location |
|----------|-------------|----------|
| `DEEPSEEK_API_KEY` | DeepSeek API key | Cloudflare Worker secrets or `backend/config.py` |

### Optional
| Variable | Description | Default |
|----------|-------------|---------|
| `API_BASE` | Backend URL for frontend | `https://moyuxiaowu.org` |

## Notes for AI Agents

1. **No Package Manager**: No `package.json`, `requirements.txt`, or similar. Dependencies are loaded via CDN in HTML files.

2. **Client-Side Only**: The majority of logic runs in browser. Backend is only for AI API calls.

3. **Chinese Comments**: Code comments are primarily in Chinese. Use translation if needed.

4. **No Tests**: No automated tests exist. Manual testing required.

5. **Single File Architecture**: Each HTML page is self-contained with inline CSS and JavaScript.

6. **Shared Components**: `fileViewer.js` is the only shared module, used by `practice.html`.

7. **Version Management**: IndexedDB uses versioning (currently v3). When changing schema, increment version number.
