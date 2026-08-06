"""GPA Buddy 测验 agent 的工具集：封装 worker API（https://moyuxiaowu.org）。

接口形状依据 backend/worker.js：
- 认证：Authorization: Bearer <JWT>（Google 登录后由客户端注入 state.session）
- 出题：POST /api/courses/{id}/generate-banks（JSON，SSE 流式返回）
- 文本出题：POST /text_generate（FormData，SSE 流式返回）
- 错题本：bank_type='mistake' 的 cloud bank，无专用接口，
  读 = POST /api/share/{id}/download，写 = PUT /api/cloud-banks/{id}/content
"""

import json
import re

import httpx

from .a2ui import build_quiz_messages
from .state import session

BASE = "https://moyuxiaowu.org"
TIMEOUT = httpx.Timeout(180.0, connect=15.0)


# ---------- 内部辅助 ----------

def _headers() -> dict:
    return {"Authorization": f"Bearer {session['token']}"}


def _check_auth() -> dict | None:
    if not session.get("token"):
        return {"status": "error", "message": "尚未登录。请提醒用户先点击页面右上角的「Google 登录」。"}
    return None


def _consume_sse_questions(response: httpx.Response) -> list[dict]:
    """从出题接口的 SSE 流里收集题目。

    每条 `data: {...}` 是一个事件 JSON：
    - generate-banks：file_done 事件带 questions 列表；final_result 事件带 data 列表
    - text_generate：final_result 事件带 data 列表
    """
    questions: list[dict] = []
    for line in response.iter_lines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload:
            continue
        try:
            event = json.loads(payload)
        except json.JSONDecodeError:
            continue  # batch0_chunk 等原始流文本或非 JSON 行
        if isinstance(event.get("questions"), list):
            questions.extend(event["questions"])  # file_done
        data = event.get("data")
        if isinstance(data, list) and data and isinstance(data[0], dict) and "question" in data[0]:
            questions.extend(data)  # final_result
        if event.get("error"):
            raise RuntimeError(f"出题接口报错: {event.get('message') or event['error']}")
    # 去重（final_result 与 file_done 可能重复携带同一批题）
    seen, unique = set(), []
    for q in questions:
        key = q.get("question", "")
        if key and key not in seen:
            seen.add(key)
            unique.append(q)
    return unique


def _list_cloud_banks() -> list[dict]:
    resp = httpx.get(f"{BASE}/api/cloud-banks", headers=_headers(), timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json().get("banks", [])


def _find_mistake_bank(course_id: int | None) -> dict | None:
    banks = [b for b in _list_cloud_banks() if b.get("bank_type") == "mistake"]
    if course_id is not None:
        for b in banks:
            if b.get("course_id") == course_id:
                return b
    return banks[0] if banks else None


def _read_bank_content(bank_id: int) -> dict:
    resp = httpx.post(f"{BASE}/api/share/{bank_id}/download",
                      headers=_headers(), json={"password": ""}, timeout=TIMEOUT)
    resp.raise_for_status()
    return json.loads(resp.json()["content"])


def _get_or_create_mistake_bank(course_id: int | None) -> int:
    bank = _find_mistake_bank(course_id)
    if bank:
        return bank["id"]
    content = {"name": "错题本", "questions": [], "favorites": [], "isMistakeBook": True}
    body = {
        "title": "错题本",
        "content": json.dumps(content, ensure_ascii=False),
        "is_public": False,
        "bank_type": "mistake",
    }
    if course_id is not None:
        body["course_id"] = str(course_id)
    resp = httpx.post(f"{BASE}/api/cloud-banks", headers=_headers(), json=body, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()["bank"]["id"]


def _append_mistakes(bank_id: int, wrong_questions: list[dict]) -> int:
    """把错题写进错题本；已存在的题累加 [N-times mistake] 计数。返回本次录入数。"""
    bank = _read_bank_content(bank_id)
    bank.setdefault("questions", [])
    existing = {q.get("question"): q for q in bank["questions"]}
    next_id = max([q.get("id", 0) for q in bank["questions"]] or [0]) + 1
    recorded = 0
    for q in wrong_questions:
        text = q.get("question", "")
        if text in existing:
            old = existing[text]
            src = old.get("source") or ""
            m = re.search(r"\[(\d+)-times mistake\]", src)
            n = int(m.group(1)) + 1 if m else 2
            old["source"] = re.sub(r"\s*\[\d+-times mistake\]", "", src) + f" [{n}-times mistake]"
        else:
            bank["questions"].append({
                "id": next_id,
                "question": text,
                "options": q.get("options") or {},
                "correctAnswer": q.get("correctAnswer", ""),
                "explanation": q.get("explanation", ""),
                "source": (q.get("source") or "agent") + " [1-times mistake]",
            })
            next_id += 1
        recorded += 1
    resp = httpx.put(f"{BASE}/api/cloud-banks/{bank_id}/content", headers=_headers(),
                     json={"content": json.dumps(bank, ensure_ascii=False)}, timeout=TIMEOUT)
    resp.raise_for_status()
    return recorded


def _gen_questions_from_text(text: str, question_count: int, lang: str, course_id: int | None) -> list[dict]:
    """用文本出题：先 /text_generate（Vertex），失败则 /fallback/pdf_generate（DeepSeek）。"""
    turnstile = session.get("turnstile") or ""
    form = {"text": text, "questionCount": str(question_count), "lang": lang,
            "fileName": "mistakes.txt", "fileType": "txt", "turnstileToken": turnstile}
    if course_id is not None:
        form["courseId"] = str(course_id)
    last_err = None
    for url, data in ((f"{BASE}/text_generate", form),
                      (f"{BASE}/fallback/pdf_generate",
                       {"text": text, "questionCount": str(question_count), "lang": lang,
                        "originalFileName": "mistakes.txt", "turnstileToken": turnstile})):
        try:
            with httpx.stream("POST", url, data=data, timeout=TIMEOUT) as resp:
                if resp.status_code >= 400:
                    resp.read()
                    last_err = f"{url} -> HTTP {resp.status_code}: {resp.text[:200]}"
                    continue
                questions = _consume_sse_questions(resp)
                if questions:
                    return questions
                last_err = f"{url} 没有返回题目"
        except (RuntimeError, httpx.HTTPError) as e:
            last_err = str(e)
    raise RuntimeError(f"文本出题失败: {last_err}")


# ---------- Agent 工具 ----------

def check_login() -> dict:
    """检查当前登录状态，返回用户信息。任何操作前如果不确定是否已登录，先调用它。"""
    err = _check_auth()
    if err:
        return err
    resp = httpx.get(f"{BASE}/auth/me", headers=_headers(), timeout=TIMEOUT)
    if resp.status_code == 401:
        session["token"] = None
        return {"status": "error", "message": "登录已过期，请提醒用户重新点击「Google 登录」。"}
    resp.raise_for_status()
    user = resp.json()
    return {"status": "success", "logged_in": True,
            "user": {"name": user.get("name"), "email": user.get("email"),
                     "balance": user.get("balance")}}


def list_moodle_courses() -> dict:
    """列出 Moodle 上可导入的课程（无需登录）。"""
    resp = httpx.get(f"{BASE}/api/moodle/courses", timeout=TIMEOUT)
    resp.raise_for_status()
    courses = [{"moodle_id": c["id"], "name": c.get("fullname"), "shortname": c.get("shortname")}
               for c in resp.json().get("courses", [])]
    return {"status": "success", "courses": courses}


def import_moodle_course(moodle_course_id: int) -> dict:
    """把一门 Moodle 课程的所有文件资源导入为一个本地课程（需要登录）。

    Args:
        moodle_course_id: list_moodle_courses 返回的 moodle_id。
    """
    err = _check_auth()
    if err:
        return err
    resp = httpx.post(f"{BASE}/api/moodle/courses/{moodle_course_id}/import",
                      headers=_headers(), timeout=TIMEOUT)
    if resp.status_code >= 400:
        return {"status": "error", "message": f"导入失败: {resp.text[:200]}"}
    data = resp.json()
    course = data.get("course") or {}
    materials = data.get("materials") or []
    return {"status": "success", "course_id": course.get("id"), "course_name": course.get("name"),
            "materials": [{"id": m["id"], "name": m["name"]} for m in materials],
            "message": f"已导入课程「{course.get('name')}」，共 {len(materials)} 个文件。"}


def list_my_courses() -> dict:
    """列出当前用户已拥有的课程（需要登录）。"""
    err = _check_auth()
    if err:
        return err
    resp = httpx.get(f"{BASE}/api/courses", headers=_headers(), timeout=TIMEOUT)
    resp.raise_for_status()
    courses = [{"course_id": c["id"], "name": c["name"],
                "material_count": c.get("material_count")} for c in resp.json().get("courses", [])]
    return {"status": "success", "courses": courses}


def create_course(name: str) -> dict:
    """创建一个新课程（需要登录）。上传本地文件前如果没有合适课程，先创建。

    Args:
        name: 课程名称。
    """
    err = _check_auth()
    if err:
        return err
    resp = httpx.post(f"{BASE}/api/courses", headers=_headers(), json={"name": name}, timeout=TIMEOUT)
    resp.raise_for_status()
    course = resp.json()["course"]
    return {"status": "success", "course_id": course["id"], "name": course["name"]}


def list_materials(course_id: int) -> dict:
    """列出一门课程下的全部资料文件（需要登录）。

    Args:
        course_id: 本地课程 id。
    """
    err = _check_auth()
    if err:
        return err
    resp = httpx.get(f"{BASE}/api/courses/{course_id}", headers=_headers(), timeout=TIMEOUT)
    if resp.status_code == 404:
        return {"status": "error", "message": "课程不存在。"}
    resp.raise_for_status()
    data = resp.json()
    materials = [{"id": m["id"], "name": m["name"], "size": m.get("size"), "type": m.get("type")}
                 for m in data.get("materials", [])]
    return {"status": "success", "course": data.get("course", {}).get("name"), "materials": materials}


def upload_material(course_id: int, file_path: str) -> dict:
    """把本地文件上传到课程作为资料（需要登录）。仅支持 .pdf / .txt / .md 文件。

    Args:
        course_id: 本地课程 id。
        file_path: 文件在本机上的绝对路径，例如 C:/Users/xxx/课件.pdf。
    """
    err = _check_auth()
    if err:
        return err
    lower = file_path.lower()
    if not lower.endswith((".pdf", ".txt", ".md")):
        return {"status": "error", "message": "仅支持 .pdf / .txt / .md 文件（Office 文件请先另存为 PDF）。"}
    name = file_path.replace("\\", "/").rsplit("/", 1)[-1]
    try:
        with open(file_path, "rb") as f:
            resp = httpx.post(f"{BASE}/api/courses/{course_id}/materials",
                              headers=_headers(), files={"file": (name, f)},
                              data={"name": name}, timeout=TIMEOUT)
    except FileNotFoundError:
        return {"status": "error", "message": f"找不到文件: {file_path}"}
    if resp.status_code >= 400:
        return {"status": "error", "message": f"上传失败: {resp.text[:200]}"}
    m = resp.json().get("material", {})
    return {"status": "success", "material_id": m.get("id"), "name": m.get("name")}


def generate_quiz(course_id: int, material_ids: list[int], question_count: int = 10, lang: str = "zh") -> dict:
    """根据课程资料生成选择题（需要登录，每个文件消耗 1 点额度）。

    调用 worker 的 /api/courses/{id}/generate-banks（SSE 流式接口）。
    成功后题目存入会话，必须接着调用 present_quiz 把测验界面展示给用户。

    Args:
        course_id: 本地课程 id。
        material_ids: 用于出题的资料 id 列表（list_materials 返回的 id，最多 10 个）。
        question_count: 题目数量，默认 10。
        lang: 题目语言，zh / zh-TW / en / ko，默认 zh。
    """
    err = _check_auth()
    if err:
        return err
    body = {"materialIds": material_ids, "questionCount": question_count,
            "lang": lang, "turnstileToken": session.get("turnstile") or ""}
    try:
        with httpx.stream("POST", f"{BASE}/api/courses/{course_id}/generate-banks",
                          headers=_headers(), json=body, timeout=TIMEOUT) as resp:
            if resp.status_code >= 400:
                resp.read()
                return {"status": "error", "message": f"出题失败: {resp.text[:200]}"}
            questions = _consume_sse_questions(resp)
    except RuntimeError as e:
        return {"status": "error", "message": str(e)}
    if not questions:
        return {"status": "error", "message": "出题接口没有返回任何题目，请重试。"}
    session["quiz"] = {"course_id": course_id, "title": "练习", "questions": questions}
    return {"status": "success", "count": len(questions),
            "message": f"已生成 {len(questions)} 道题。现在调用 present_quiz 展示测验界面。"}


def present_quiz() -> dict:
    """把当前已生成的题目以 A2UI 测验界面展示给用户。generate_quiz 或
    generate_quiz_from_mistakes 成功后必须调用本工具。"""
    quiz = session.get("quiz")
    if not quiz or not quiz.get("questions"):
        return {"status": "error", "message": "当前没有可展示的题目，请先生成题目。"}
    messages = build_quiz_messages(quiz["questions"], quiz.get("title") or "测验")
    return {"status": "success", "a2ui_messages": messages,
            "message": f"测验界面（{len(quiz['questions'])} 题）已推送到客户端，等待用户作答。"}


def grade_quiz(answers: dict[str, str]) -> dict:
    """给用户提交的答案判分；已登录时把错题写入云端错题本。

    用户作答后客户端会发来 [QUIZ_ANSWERS] 消息，解析其中的 JSON 作为 answers 传入。

    Args:
        answers: 题号到选项字母的映射，例如 {"q1": "A", "q2": "C"}。
    """
    quiz = session.get("quiz")
    if not quiz or not quiz.get("questions"):
        return {"status": "error", "message": "没有进行中的测验。"}
    results, wrong = [], []
    for i, q in enumerate(quiz["questions"], start=1):
        user_ans = (answers.get(f"q{i}") or "").strip().upper()
        correct = (q.get("correctAnswer") or "").strip().upper()
        ok = user_ans == correct
        results.append({"no": i, "question": q.get("question", "")[:80],
                        "your_answer": user_ans or "（未作答）", "correct_answer": correct,
                        "correct": ok, "explanation": q.get("explanation", "")})
        if not ok:
            wrong.append(q)
    score = sum(1 for r in results if r["correct"])
    mistake_count = 0
    note = ""
    if wrong:
        if session.get("token"):
            bank_id = _get_or_create_mistake_bank(quiz.get("course_id"))
            mistake_count = _append_mistakes(bank_id, wrong)
        else:
            note = "（未登录，本次错题未写入错题本；登录后重新提交即可记录）"
    return {"status": "success", "score": score, "total": len(results),
            "results": results, "mistakes_recorded": mistake_count,
            "message": (f"得分 {score}/{len(results)}。"
                        + (f"已将 {mistake_count} 道错题写入错题本。" if mistake_count else "")
                        + note)}


def list_mistakes(course_id: int | None = None) -> dict:
    """查看错题本内容（需要登录）。

    Args:
        course_id: 可选，只看某门课程的错题本；不传则返回最近使用的错题本。
    """
    err = _check_auth()
    if err:
        return err
    bank = _find_mistake_bank(course_id)
    if not bank:
        return {"status": "success", "mistakes": [], "message": "错题本是空的。"}
    content = _read_bank_content(bank["id"])
    mistakes = [{"question": q.get("question"), "correctAnswer": q.get("correctAnswer"),
                 "source": q.get("source")} for q in content.get("questions", [])]
    return {"status": "success", "bank_id": bank["id"], "count": len(mistakes), "mistakes": mistakes}


def generate_quiz_from_mistakes(course_id: int | None = None, question_count: int = 10, lang: str = "zh") -> dict:
    """根据错题本里的错题生成新一套练习题（需要登录）。

    把错题整理成文本后调用 worker 的 /text_generate 出同知识点新题。
    成功后题目存入会话，必须接着调用 present_quiz 把测验界面展示给用户。

    Args:
        course_id: 可选，使用某门课程的错题本；不传则用最近的错题本。
        question_count: 新题数量，默认 10。
        lang: 题目语言，默认 zh。
    """
    err = _check_auth()
    if err:
        return err
    bank = _find_mistake_bank(course_id)
    if not bank:
        return {"status": "error", "message": "错题本是空的，无法根据错题出题。先做一次练习积累错题。"}
    mistakes = _read_bank_content(bank["id"]).get("questions", [])
    if not mistakes:
        return {"status": "error", "message": "错题本是空的，无法根据错题出题。先做一次练习积累错题。"}
    lines = ["以下是学生做错的题目，请围绕这些错题涉及的知识点出新的练习题（不要照抄原题）：\n"]
    for i, q in enumerate(mistakes[:50], start=1):
        opts = "；".join(f"{k}.{v}" for k, v in (q.get("options") or {}).items())
        lines.append(f"{i}. {q.get('question')}\n选项：{opts}\n正确答案：{q.get('correctAnswer')}\n解析：{q.get('explanation', '')}\n")
    try:
        questions = _gen_questions_from_text("\n".join(lines), question_count, lang, course_id)
    except RuntimeError as e:
        return {"status": "error", "message": str(e)}
    if not questions:
        return {"status": "error", "message": "出题接口没有返回任何题目，请重试。"}
    session["quiz"] = {"course_id": course_id, "title": "错题重练", "questions": questions}
    return {"status": "success", "count": len(questions),
            "message": f"已根据错题生成 {len(questions)} 道新题。现在调用 present_quiz 展示测验界面。"}
