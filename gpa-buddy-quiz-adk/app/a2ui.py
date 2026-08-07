"""构造 A2UI (Agent-to-UI) v0.8 风格消息，用于把测验界面推送给客户端渲染。

遵循 A2UI 的消息结构：surfaceUpdate（扁平组件列表 + 邻接表）→ beginRendering。
客户端（client/index.html）实现最小渲染器，支持的组件：
Text / Column / RadioGroup / Button。
"""

CATALOG_ID = "https://a2ui.org/specification/v0_8/standard_catalog_definition.json"


def build_quiz_messages(questions: list[dict], title: str = "测验", surface_id: str = "quiz") -> list[dict]:
    """把题目列表转换成 A2UI 消息序列。

    questions: [{"question": str, "options": {"A":..,"B":..}, "correctAnswer": "A", ...}]
    选项组件的 name 为 q1..qN，提交时客户端回传 {"q1": "A", ...}。
    """
    child_ids: list[str] = ["quiz_title"]
    components: list[dict] = [
        {
            "id": "quiz_title",
            "component": {"Text": {"text": f"{title}（共 {len(questions)} 题）", "usageHint": "h2"}},
        }
    ]

    for i, q in enumerate(questions, start=1):
        text_id = f"q{i}_text"
        opts_id = f"q{i}_options"
        components.append({
            "id": text_id,
            "component": {"Text": {"text": f"{i}. {q.get('question', '')}"}},
        })
        options = [
            {"value": key, "label": f"{key}. {val}"}
            for key, val in (q.get("options") or {}).items()
        ]
        components.append({
            "id": opts_id,
            "component": {"RadioGroup": {"name": f"q{i}", "options": options}},
        })
        child_ids += [text_id, opts_id]

    components.append({
        "id": "quiz_submit",
        "component": {"Button": {"label": "提交答案", "action": {"name": "submit_quiz"}}},
    })
    child_ids.append("quiz_submit")

    components.insert(0, {
        "id": "root",
        "component": {"Column": {"children": {"explicitList": child_ids}}},
    })

    return [
        {"surfaceUpdate": {"surfaceId": surface_id, "components": components}},
        {"beginRendering": {"surfaceId": surface_id, "root": "root", "catalogId": CATALOG_ID}},
    ]
