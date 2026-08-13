# gpa-buddy-quizgen-adk

GPA Buddy 出题 Agent（ADK 工作流版 `/api/quiz/generate`）：上传课件出题 + 现有题库导入合并接口。

## 工作流（SequentialAgent）

1. **classifier_agent**（gemini-2.5-flash，结构化输出）：判断上传文件是不是现成题库，是则数出选择题总数（单选+多选）。
2. **QuizFanoutAgent**（自定义 BaseAgent）：
   - 题库 → 按范围分批"原题直读"提取（资料带答案则以资料为准）
   - 课件 → 按页码范围分批出题
   - 两条分支共用批量执行器：每批 ≤20 题，batch0 先跑，其余并行，失败重试 + JSON 解析兜底
   - 以 `quiz_event` 事件流式回报进度（`classify_done` → `batch_done` → `final_result` → `agent_done`），Worker 翻译为 SSE

## 输入

Worker（`backend/worker.js` 的 `runQuizViaAgentRuntime`）转发的单条 user 消息：

- `parts[0]`: `file_data` —— gs:// 文件（PDF 或 text/plain；RE 服务账号需 bucket objectViewer）
- `parts[1]`: `text` —— JSON `{"lang","custom_prompt","question_count","file_name","page_count","file_uri","mime_type"}`

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CLASSIFIER_MODEL_ID` | `gemini-2.5-flash` | 分类器模型 |
| `QUIZ_MODEL_ID` | `gemini-2.5-flash` | 分批生成/提取模型 |

Worker 侧开关：`ADK_QUIZ_ENABLED` / `ADK_QUIZ_RUNTIME_ID` / `ADK_QUIZ_REGION`（见 `backend/wrangler.toml`）。

## 部署

```bash
uv lock
agents-cli deploy --project gpa-490510 --region us-central1
```
