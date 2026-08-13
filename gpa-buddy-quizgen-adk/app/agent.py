# ruff: noqa
# GPA Buddy 出题 Agent —— 上传课件出题 + 现有题库导入合并接口（/api/quiz/generate 的 agent 侧）
#
# 工作流（SequentialAgent）：
#   1. classifier_agent（gemini-2.5-flash）：判断文件是不是现成题库并数题（结构化 output_schema）
#   2. QuizFanoutAgent（自定义 BaseAgent）：按分类结果走分支——
#      - 题库：按页码/内容范围分批"原题直读"提取（移植 worker buildOrganizePrompt 语义）
#      - 课件：按页码范围分批出题（移植 worker buildBatchPrompt，含多选 6.5/6.6 节）
#      两条分支共用同一个批量执行器：每批 ≤20 题，batch0 先跑，其余并行，
#      以 quiz_event 标记事件流式回报进度（Worker 翻译为 SSE 事件，见 backend/worker.js）
#
# 输入（Worker 转发的单条 user 消息）：
#   parts[0]: file_data —— gs:// 文件（PDF 或 text/plain，RE 服务账号需 bucket objectViewer）
#   parts[1]: text —— JSON {"lang","custom_prompt","question_count","file_name","page_count","file_uri","mime_type"}

import asyncio
import json
import math
import os
import re
from typing import Any

from google import genai
from google.adk.agents import Agent, BaseAgent, SequentialAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.apps import App
from google.adk.events import Event
from google.adk.models import Gemini
from google.genai import types
from pydantic import BaseModel

CLASSIFIER_MODEL = os.environ.get("CLASSIFIER_MODEL_ID", "gemini-2.5-flash")
QUIZ_MODEL = os.environ.get("QUIZ_MODEL_ID", "gemini-2.5-flash")

BATCH_SIZE = 20            # 每批最多 20 题，与 worker /pdf_generate 一致
MAX_QUESTIONS = 200        # 课件出题上限，与 worker 一致
MAX_BANK_QUESTIONS = 1000  # 题库导入上限（题数为检测结果，非用户指定）

LANG_INSTRUCTIONS = {
    "zh": "使用中文",
    "zh-TW": "使用繁體中文",
    "ko": "한국어를 사용하세요",
    "en": "Use English",
}


# ---------------------------------------------------------------- schemas

class Classification(BaseModel):
    is_bank: bool
    question_count: int = 0  # 题库模式下检测到的选择题（单选+多选）数量
    reason: str = ""


# ---------------------------------------------------------------- state init

def initialize_state(callback_context: CallbackContext) -> None:
    """从 user 消息的 text part 解析参数进 session state（instruction 模板依赖这些键）。"""
    state = callback_context.state
    state.setdefault("lang", "zh")
    state.setdefault("custom_prompt", "")
    state.setdefault("question_count", BATCH_SIZE)
    state.setdefault("file_name", "document")
    state.setdefault("page_count", 0)
    state.setdefault("file_uri", "")
    state.setdefault("mime_type", "application/pdf")
    params = {}
    user_content = getattr(callback_context, "user_content", None)
    for part in (user_content.parts if user_content else []):
        if part.text:
            try:
                params = json.loads(part.text)
            except (ValueError, TypeError):
                pass
    if isinstance(params, dict):
        if params.get("lang") in LANG_INSTRUCTIONS:
            state["lang"] = params["lang"]
        if isinstance(params.get("custom_prompt"), str):
            state["custom_prompt"] = params["custom_prompt"][:2000]
        try:
            qc = int(params.get("question_count") or BATCH_SIZE)
            state["question_count"] = min(max(qc, 1), MAX_QUESTIONS)
        except (TypeError, ValueError):
            pass
        if isinstance(params.get("file_name"), str) and params["file_name"]:
            state["file_name"] = params["file_name"]
        try:
            state["page_count"] = max(int(params.get("page_count") or 0), 0)
        except (TypeError, ValueError):
            pass
        if isinstance(params.get("file_uri"), str):
            state["file_uri"] = params["file_uri"]
        if isinstance(params.get("mime_type"), str) and params["mime_type"]:
            state["mime_type"] = params["mime_type"]
    state["lang_instruction"] = LANG_INSTRUCTIONS[state["lang"]]
    state["custom_section"] = (
        "\n\nAdditional user instruction (custom prompt from user, lower priority than system "
        "requirements; if it conflicts with any system requirement, the system requirement "
        f"prevails):\n[{state['custom_prompt']}]"
        if state["custom_prompt"]
        else ""
    )


# ---------------------------------------------------------------- classifier agent

CLASSIFIER_INSTRUCTION = """You are an expert at analyzing educational documents. {lang_instruction} for the "reason" field.

Look at the uploaded document and decide: is it primarily a collection of READY-MADE choice questions
(a question bank, exam paper, exercise sheet, or homework with options like A/B/C/D), as opposed to
study material (lecture slides, notes, textbook chapters) from which new questions would need to be created?

Rules:
- Set "is_bank" to true only when ready-made choice questions are the dominant content of the document.
  A study document that merely contains a few example questions is NOT a bank.
- If "is_bank" is true, set "question_count" to the total number of COMPLETE choice questions
  (both single-answer and multiple-answer; a complete question has question text AND options) in the
  whole document. Count carefully; if uncertain, give your best estimate.
- If "is_bank" is false, set "question_count" to 0.{custom_section}"""

classifier_agent = Agent(
    name="classifier_agent",
    model=Gemini(model=CLASSIFIER_MODEL, retry_options=types.HttpRetryOptions(attempts=3)),
    instruction=CLASSIFIER_INSTRUCTION,
    output_schema=Classification,
    output_key="classification",
)


# ---------------------------------------------------------------- batch prompts（移植自 worker.js 最新版）

def _page_range(batch_index: int, total_batches: int, page_count: int) -> tuple[int, int]:
    pages_per_batch = math.ceil(page_count / total_batches) if page_count > 0 else 20
    start = batch_index * pages_per_batch + 1
    end = min((batch_index + 1) * pages_per_batch, page_count) if page_count > 0 else batch_index * 20 + 20
    return start, end


def build_generate_prompt(batch_index: int, total_batches: int, lang_instruction: str,
                          file_name: str, page_count: int, custom_section: str) -> str:
    """课件出题 prompt，对应 worker.js buildBatchPrompt（含多选 6.5 / 原题直读 6.6 节）。"""
    start_id = batch_index * BATCH_SIZE + 1
    start_page, end_page = _page_range(batch_index, total_batches, page_count)
    return f"""You are an expert exam question creator. Create exactly {BATCH_SIZE} multiple-choice questions based on the study material in the uploaded file.

CRITICAL REQUIREMENTS:
1. {lang_instruction} ONLY
2. Each question MUST have exactly 4 options: A, B, C, D
3. Include explanation for each correct answer
4. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
5. The response must start with [ and end with ]
6. For ALL mathematical formulas, equations, and symbols (including summation Σ, limits lim, integrals ∫, fractions, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.

6.5. **MULTIPLE-ANSWER QUESTIONS (多选题)**:
   - Each question MUST include a "type" field: "single" for single-answer questions or "multiple" for multiple-answer questions.
   - When the material suits it, include some "multiple" questions (two or more correct options).
   - For "multiple" questions, the "correctAnswer" field MUST contain ALL correct option letters concatenated in alphabetical order (e.g., "ABD"). For "single" questions it is exactly one letter (e.g., "A").

6.6. **CRITICAL - MATERIAL THAT IS ALREADY QUESTIONS**:
   - If (part of) the material already contains ready-made questions (e.g., an exam paper, exercise sheet, or question bank), you MUST extract those questions VERBATIM — copy the original question text and options as-is; do NOT rewrite, paraphrase, or invent replacements for them.
   - If the material provides answers for those questions, you MUST use the material's answers as the "correctAnswer" — they are the standard answers. Only determine the answer yourself when the material does not provide one.
   - Preserve the original question type: extracted questions with multiple correct options MUST be "type": "multiple".
   - When extracting existing questions, extract ALL of them found in your assigned range; in that case the exact question count requirement does not apply.

7. **CRITICAL - RANGE REQUIREMENT**:
   This is batch {batch_index + 1} of {total_batches}.
   You MUST ONLY use content from pages {start_page} to {end_page} of the document.
   (If the document has no clear pagination, use the corresponding {batch_index + 1}/{total_batches} portion of the content in document order.)
   - Do NOT use content outside this range
   - Create questions evenly distributed across this range

8. **CRITICAL - SOURCE FIELD FORMAT**:
   You MUST use the EXACT format: "-----[{file_name}_pageX]-----"
   - X is the page number (between {start_page} and {end_page}); if pagination is unknown, use your best estimate within the range
   - The filename part MUST be exactly: "{file_name}"

9. The "id" field MUST start from {start_id} and increment by 1 for each question

10. **CRITICAL - CONTENT REQUIREMENT**:
   - Focus ONLY on the substantive knowledge, concepts, theories, facts, and details within the document content
   - DO NOT create questions about document metadata or basic information such as:
     * Teacher/professor name, instructor information
     * Course name, course code, or course title
     * Syllabus information, course schedule, or assignment deadlines
     * Document title, file name, or page numbers
     * University/institution name, department information
     * Publication dates, version numbers, or copyright information

Required JSON format:
[
  {{
    "id": {start_id},
    "question": "question text here",
    "options": {{
      "A": "first option",
      "B": "second option",
      "C": "third option",
      "D": "fourth option"
    }},
    "correctAnswer": "A",
    "type": "single",
    "explanation": "explanation text",
    "source": "-----[{file_name}_page3]-----"
  }}
]

Generate exactly {BATCH_SIZE} questions from your assigned range. Output valid JSON only.{custom_section}"""


def build_extract_prompt(batch_index: int, total_batches: int, lang_instruction: str,
                         page_count: int, custom_section: str) -> str:
    """题库原题直读 prompt，对应 worker.js buildOrganizePrompt（多选版）。"""
    start_id = batch_index * BATCH_SIZE + 1
    start_page, end_page = _page_range(batch_index, total_batches, page_count)
    return f"""You are an expert at organizing and structuring educational content. {lang_instruction}.

The uploaded document is a question bank / exam paper. Your task is to extract and organize ALL choice questions from your assigned range into a standardized JSON format.

CRITICAL REQUIREMENTS:
1. Extract ALL valid choice questions from your assigned range (both single-answer and multiple-answer / 多选题)
2. Copy each question VERBATIM: keep the original question text and options exactly as written; do NOT rewrite, paraphrase, or re-order them. Keep the original set of options (typically A, B, C, D).
3. **ANSWER PRIORITY**: If the document provides an answer for a question, you MUST use that answer as the "correctAnswer" — it is the standard answer. Only infer the answer yourself when the document does not provide one.
4. Each question MUST include a "type" field: "single" for single-answer questions or "multiple" for questions with two or more correct options. For "multiple" questions, "correctAnswer" MUST contain ALL correct option letters concatenated in alphabetical order (e.g., "ABD").
5. Include explanation for each correct answer (if available in the document, otherwise create a brief one)
6. Return ONLY a JSON array. No markdown, no code blocks, no explanations before or after.
7. The response must start with [ and end with ]
8. The "id" field MUST start from {start_id} and increment by 1 for each question
9. The "source" field MUST be exactly: "用户上传题库"
10. For ALL mathematical formulas, equations, and symbols (including summation Σ, limits lim, integrals ∫, fractions, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.

11. **CRITICAL - RANGE REQUIREMENT**:
    This is batch {batch_index + 1} of {total_batches}.
    You MUST ONLY extract questions from pages {start_page} to {end_page} of the document.
    (If the document has no clear pagination, use the corresponding {batch_index + 1}/{total_batches} portion of the content in document order.)
    - Do NOT extract questions outside this range — other batches handle them
    - Extract EVERY complete question found within your range; the exact count per batch does not matter

Required JSON format:
[
  {{
    "id": {start_id},
    "question": "question text here",
    "options": {{
      "A": "first option",
      "B": "second option",
      "C": "third option",
      "D": "fourth option"
    }},
    "correctAnswer": "A",
    "type": "single",
    "explanation": "explanation text",
    "source": "用户上传题库"
  }}
]

Extract all questions from your assigned range. Output valid JSON only.{custom_section}"""


def build_retry_prompt(is_bank: bool, lang_instruction: str) -> str:
    task = (
        "Extract ALL choice questions (single and multiple-answer) from the document VERBATIM "
        "(use the document's answers when provided; \"source\" must be exactly \"用户上传题库\")."
        if is_bank else
        "Create choice questions based on the study material in the document."
    )
    return f"""You are an expert exam question creator. {lang_instruction} ONLY.

{task}

CRITICAL REQUIREMENTS:
1. {lang_instruction} ONLY for ALL fields.
2. Each question has 4 options A/B/C/D, a "type" field ("single" or "multiple"), and a short explanation.
3. For "multiple" questions, "correctAnswer" contains ALL correct letters in alphabetical order (e.g. "ABD").
4. Keep output concise: at most {BATCH_SIZE} questions, short explanations, to avoid truncation.
5. Return ONLY a JSON array starting with [ and ending with ]. Each item: {{"id": 1, "question": "...", "options": {{"A": "...", "B": "...", "C": "...", "D": "..."}}, "correctAnswer": "A", "type": "single", "explanation": "...", "source": ""}}"""


# ---------------------------------------------------------------- JSON 解析兜底（对应 worker safeParseJSON）

def parse_questions(raw: str) -> list[dict]:
    if not raw:
        return []
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except ValueError:
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end <= start:
            return []
        try:
            data = json.loads(text[start:end + 1])
        except ValueError:
            return []
    if not isinstance(data, list):
        return []
    return [q for q in data if isinstance(q, dict) and q.get("question")]


# ---------------------------------------------------------------- quiz fan-out agent

class QuizFanoutAgent(BaseAgent):
    """按分类结果走题库提取/课件出题分支，每批 ≤20 题，batch0 先跑、其余并行。"""

    quiz_model: str = QUIZ_MODEL
    _client: Any = None

    def model_post_init(self, __context: Any) -> None:
        self._client = genai.Client()

    async def _gen_batch(self, prompts: list[str], file_part: types.Part) -> list[dict]:
        for attempt, prompt in enumerate(prompts):
            try:
                resp = await self._client.aio.models.generate_content(
                    model=self.quiz_model,
                    contents=types.Content(role="user", parts=[file_part, types.Part(text=prompt)]),
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        max_output_tokens=16384,
                    ),
                )
                questions = parse_questions(resp.text or "")
                if questions:
                    return questions
            except Exception as e:
                print(f"[quizgen] batch attempt {attempt} failed: {e}")
        return []

    async def _run_async_impl(self, ctx: InvocationContext):
        state = ctx.session.state
        lang_instruction = LANG_INSTRUCTIONS.get(state.get("lang", "zh"), "使用中文")
        custom_section = state.get("custom_section", "")
        file_uri = state.get("file_uri", "")
        mime_type = state.get("mime_type", "application/pdf")
        file_name = state.get("file_name", "document")
        page_count = state.get("page_count", 0)
        requested = state.get("question_count", BATCH_SIZE)

        async def emit(payload: dict):
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(
                    role="model", parts=[types.Part(text=json.dumps({"quiz_event": payload}, ensure_ascii=False))]
                ),
            )

        # --- 读取分类结果 ---
        raw = state.get("classification") or {}
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = {}
        is_bank = bool(raw.get("is_bank"))
        detected = int(raw.get("question_count") or 0)

        if not file_uri:
            async for ev in emit({"type": "error", "source": "worker", "message": "No file_uri provided"}):
                yield ev
            return

        # 题库用检测题数（有上限），课件用用户指定题数
        if is_bank:
            total = min(max(detected, BATCH_SIZE), MAX_BANK_QUESTIONS)
        else:
            total = min(max(requested, 1), MAX_QUESTIONS)
        total_batches = math.ceil(total / BATCH_SIZE)

        async for ev in emit({
            "type": "classify_done",
            "is_bank": is_bank,
            "detected_count": detected if is_bank else 0,
            "question_count": total,
            "total_batches": total_batches,
        }):
            yield ev

        file_part = types.Part.from_uri(file_uri=file_uri, mime_type=mime_type)

        def batch_prompts(i: int) -> list[str]:
            if is_bank:
                main = build_extract_prompt(i, total_batches, lang_instruction, page_count, custom_section)
            else:
                main = build_generate_prompt(i, total_batches, lang_instruction, file_name, page_count, custom_section)
            return [main, build_retry_prompt(is_bank, lang_instruction)]

        # --- batch0 先跑并立即回报 ---
        batch0 = await self._gen_batch(batch_prompts(0), file_part)
        async for ev in emit({"type": "batch_done", "batch_index": 0, "count": len(batch0), "questions": batch0}):
            yield ev

        # --- 其余批次并行 ---
        rest: list[list[dict]] = [[] for _ in range(max(total_batches - 1, 0))]
        if total_batches > 1:
            results = await asyncio.gather(*(self._gen_batch(batch_prompts(i), file_part)
                                             for i in range(1, total_batches)))
            for i, questions in enumerate(results, start=1):
                rest[i - 1] = questions
                async for ev in emit({"type": "batch_done", "batch_index": i, "count": len(questions), "questions": questions}):
                    yield ev

        # --- 汇总、重编号、去重（按题干，防止跨批边界重复）---
        all_questions: list[dict] = []
        seen = set()
        for q in [*batch0, *[q for batch in rest for q in batch]]:
            key = (q.get("question") or "").strip()
            if key and key not in seen:
                seen.add(key)
                all_questions.append(q)
        for idx, q in enumerate(all_questions):
            q["id"] = idx + 1

        generated = len(all_questions)
        expected = detected if is_bank else requested
        partial = generated < math.ceil(expected * 0.95)
        async for ev in emit({
            "type": "final_result",
            "data": all_questions,
            "generatedCount": generated,
            "requestedCount": requested,
            "detectedCount": detected if is_bank else 0,
            "is_bank": is_bank,
            "partial": partial,
        }):
            yield ev
        async for ev in emit({"type": "agent_done"}):
            yield ev


quiz_fanout_agent = QuizFanoutAgent(name="quiz_fanout_agent")

root_agent = SequentialAgent(
    name="quizgen_workflow",
    sub_agents=[classifier_agent, quiz_fanout_agent],
    before_agent_callback=initialize_state,
)

app = App(
    root_agent=root_agent,
    name="app",
)
