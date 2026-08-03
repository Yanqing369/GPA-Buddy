# ruff: noqa
# GPA-Buddy 知识图谱导学 Agent —— 多智能体工作流版 /api/tutor/generate
#
# 工作流（SequentialAgent）：
#   1. skeleton_agent（gemini-2.5-pro）：分析 PDF，输出知识图谱骨架（结构化 output_schema）
#   2. NodeFanoutAgent（自定义 BaseAgent）：拓扑分批，并行调用 gemini-2.5-flash-lite
#      逐节点生成微学习内容（结构化输出 + 重试 + 兜底），并以 tutor_event 标记事件
#      流式回报进度（Worker 将其翻译为前端既有 SSE 事件类型，前端零改动）
#
# 输入（Worker 转发的单条 user 消息）：
#   parts[0]: file_data —— gs:// 的 PDF（RE 服务账号需 bucket objectViewer）
#   parts[1]: text —— JSON {"lang": "zh|zh-TW|en|ko", "custom_prompt": "...", "file_uri": "gs://..."}

import asyncio
import json
import os
from typing import Any, Literal

from google import genai
from google.adk.agents import Agent, BaseAgent, SequentialAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import InvocationContext
from google.adk.apps import App
from google.adk.events import Event
from google.adk.models import Gemini
from google.genai import types
from pydantic import BaseModel, Field

SKELETON_MODEL = os.environ.get("SKELETON_MODEL_ID", "gemini-2.5-pro")
NODE_MODEL = os.environ.get("NODE_MODEL_ID", "gemini-2.5-flash-lite")

BATCH_SIZE = 5
MAX_HARD_OUT = 3
MAX_SOFT_OUT = 2

LANG_INSTRUCTIONS = {
    "zh": "使用中文",
    "zh-TW": "使用繁體中文",
    "ko": "한국어를 사용하세요",
    "en": "Use English",
}


# ---------------------------------------------------------------- schemas

class SkNode(BaseModel):
    id: str
    name: str
    importance: Literal["gateway", "landmark", "normal"] = "normal"


class SkEdge(BaseModel):
    from_: str = Field(alias="from")
    to: str
    type: Literal["hard", "soft"] = "hard"
    reason: str = ""


class Skeleton(BaseModel):
    nodes: list[SkNode]
    edges: list[SkEdge]


class CoreConcept(BaseModel):
    title: str
    content: str
    source: str = ""


class CheckActivity(BaseModel):
    # Literal 约束：自由 str 时模型可能返回 "multiple_choice" 等值，前端只认 "choice"
    type: Literal["choice"] = "choice"
    question: str
    options: list[str]
    correct: int = 0


class NodeContent(BaseModel):
    nodeId: str
    introQuestion: str
    coreConcepts: list[CoreConcept]
    checkActivities: list[CheckActivity] = []
    exitHook: str


# ---------------------------------------------------------------- state init

def initialize_state(callback_context: CallbackContext) -> None:
    """从 user 消息的 text part 解析参数进 session state（instruction 模板依赖这些键）。"""
    state = callback_context.state
    state.setdefault("lang", "zh")
    state.setdefault("custom_prompt", "")
    state.setdefault("file_uri", "")
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
        if isinstance(params.get("file_uri"), str):
            state["file_uri"] = params["file_uri"]
    state["lang_instruction"] = LANG_INSTRUCTIONS[state["lang"]]
    state["custom_section"] = (
        "\n\nAdditional user instruction (custom prompt from user, lower priority than system "
        "requirements; if it conflicts with any system requirement, the system requirement "
        f"prevails):\n[{state['custom_prompt']}]"
        if state["custom_prompt"]
        else ""
    )


# ---------------------------------------------------------------- skeleton agent

SKELETON_INSTRUCTION = """You are an expert educational content analyzer. {lang_instruction}.

Analyze the uploaded study material and create a knowledge graph skeleton that breaks down the material into learnable nodes and dependency edges.

CRITICAL REQUIREMENTS:
1. {lang_instruction} ONLY for ALL fields. This includes node names, edge reasons, and every string in the JSON. Do NOT use the document's original language.

Guidelines:
- "gateway" nodes are prerequisites that unlock many downstream concepts.
- "landmark" nodes are important summaries or milestones (no exercises needed, just reading).
- "hard" edges mean the target node cannot be learned before the source node is mastered.
- "soft" edges mean the target node is related but not strictly dependent.
- The graph MUST be a DAG (directed acyclic graph). NO cycles are allowed.
- Keep the structure clean and hierarchical like a learning path or tree. AVOID dense spiderweb-like cross-connections.
- Each node should have at most 3 outgoing hard edges and at most 2 outgoing soft edges.
- Use soft edges sparingly — only when two concepts are genuinely related but not prerequisite-dependent.
- Every non-root node MUST have at least one incoming hard edge. Do NOT create nodes that rely solely on soft edges for connectivity.
- Intelligently determine the number of nodes based on content complexity:
  - Short/simple documents (a few pages or a single light chapter): 5–10 nodes
  - Medium documents (several chapters or moderate topics): 10–25 nodes
  - Complex/long documents (a full book, comprehensive course, or highly detailed material): 25–50 nodes
- Maximum node count: 50. Never exceed 50 nodes regardless of document length.
- Use concise, meaningful names for nodes.{custom_section}"""

skeleton_agent = Agent(
    name="skeleton_agent",
    model=Gemini(model=SKELETON_MODEL, retry_options=types.HttpRetryOptions(attempts=3)),
    instruction=SKELETON_INSTRUCTION,
    output_schema=Skeleton,
    output_key="skeleton",
)


# ---------------------------------------------------------------- helpers (ported from worker.js)

def _would_create_cycle(edges: list[dict], new_from: str, new_to: str) -> bool:
    adj: dict[str, list[str]] = {}
    for e in edges:
        adj.setdefault(e["from"], []).append(e["to"])
    visited, stack = set(), [new_to]
    while stack:
        curr = stack.pop()
        if curr == new_from:
            return True
        if curr in visited:
            continue
        visited.add(curr)
        stack.extend(n for n in adj.get(curr, []) if n not in visited)
    return False


def sanitize_skeleton(skeleton: dict) -> dict:
    nodes = skeleton.get("nodes") or []
    edges = skeleton.get("edges") or []
    node_ids = {n["id"] for n in nodes}

    # 兜底：只有 soft 入边的节点，升级第一条 soft 边为 hard
    hard_in = {n["id"]: 0 for n in nodes}
    soft_in_idx = {n["id"]: [] for n in nodes}
    for idx, e in enumerate(edges):
        if e.get("from") not in node_ids or e.get("to") not in node_ids:
            continue
        if e.get("type") == "hard":
            hard_in[e["to"]] += 1
        else:
            soft_in_idx[e["to"]].append(idx)
    for n in nodes:
        if hard_in[n["id"]] == 0 and soft_in_idx[n["id"]]:
            edges[soft_in_idx[n["id"]][0]]["type"] = "hard"

    valid = [e for e in edges if e.get("from") in node_ids and e.get("to") in node_ids]
    out_counts = {n["id"]: {"hard": 0, "soft": 0} for n in nodes}
    filtered = []
    for e in valid:
        t = "soft" if e.get("type") == "soft" else "hard"
        limit = MAX_SOFT_OUT if t == "soft" else MAX_HARD_OUT
        if out_counts[e["from"]][t] < limit and not _would_create_cycle(filtered, e["from"], e["to"]):
            filtered.append(e)
            out_counts[e["from"]][t] += 1
    skeleton["edges"] = filtered
    return skeleton


def select_batch_nodes(nodes, in_degree, parent_map, content_map, max_size=BATCH_SIZE):
    unprocessed = [n for n in nodes if n["id"] not in content_map]
    unprocessed.sort(key=lambda n: in_degree[n["id"]])
    batch, batch_ids = [], set()
    for node in unprocessed:
        if len(batch) >= max_size:
            break
        parents = parent_map.get(node["id"], [])
        if all(pid in content_map or pid in batch_ids for pid in parents):
            batch.append(node)
            batch_ids.add(node["id"])
    return batch


def build_node_prompt(node: dict, parent_hooks: list[str], lang_instruction: str) -> str:
    prev = ""
    if parent_hooks:
        prev = "\n\nPrevious nodes summary:\n" + "\n".join(
            f"{i + 1}. {h}" for i, h in enumerate(parent_hooks)
        )
    return f"""You are an expert tutor creating micro-learning content. {lang_instruction}.

Create the learning content for the following node:
- Node ID: {node['id']}
- Node Name: {node['name']}
- Importance: {node.get('importance') or 'normal'}{prev}

CRITICAL REQUIREMENTS:
1. {lang_instruction} ONLY for ALL fields. This includes introQuestion, coreConcept titles, coreConcept content, checkActivities questions and options, and exitHook. Do NOT use the document's original language.
2. The "nodeId" field MUST be exactly "{node['id']}".

Guidelines:
- introQuestion should be thought-provoking and related to the real world.
- coreConcepts should have 2-4 items, each explaining one key idea clearly.
- For each coreConcept, you MUST include a [source] field using the EXACT page marker format found in the document (e.g. -----[abc123_page3]-----). This allows the learner to trace back to the original material. If multiple pages are relevant, pick the most representative one.
- For ALL mathematical formulas, equations, Greek letters, and symbols (including \\Omega, \\sigma, \\mathbb, \\sum, integrals, inequalities, etc.), you MUST use standard LaTeX format and wrap them with $...$ for inline math.
- checkActivities should have 1-3 items. For "landmark" importance, you may return an empty array [].
- EXITHOOK REQUIREMENT (critical): The exitHook must be an independent, complete summary of this node's knowledge. It will be fed to downstream nodes as the ONLY context for writing their warm-up questions. It MUST capture the 1-2 most transferable core concepts in concise but fully informative language. A reader who only sees the exitHook (without the node title) should be able to understand what was learned. Do NOT make it a vague phrase like 'student understands derivatives'; instead write something like 'The student now knows that a derivative describes the instantaneous rate of change of a function at a single point, and geometrically represents the slope of the tangent line.'"""


def build_node_prompt_retry(node: dict, lang_instruction: str) -> str:
    return f"""You are an expert tutor. {lang_instruction} ONLY for ALL output fields.

Create a SHORT learning content for this node:
- Node ID: {node['id']}
- Node Name: {node['name']}
- Importance: {node.get('importance') or 'normal'}

CRITICAL REQUIREMENTS:
1. {lang_instruction} ONLY. Do NOT use the document's original language.
2. The "nodeId" field MUST be exactly "{node['id']}".
3. Keep content concise to avoid truncation.

Guidelines:
- coreConcepts: 1-2 short items only.
- checkActivities: return [].
- exitHook: keep under 150 words.
- If you cannot determine a source page, leave source as an empty string."""


def _stub_content(node: dict) -> dict:
    return {
        "nodeId": node["id"],
        "introQuestion": f"What is {node['name']}?",
        "coreConcepts": [
            {
                "title": node["name"],
                "content": "Content generation failed. Please try regenerating the graph.",
                "source": "",
            }
        ],
        "checkActivities": [],
        "exitHook": node["name"],
    }


# ---------------------------------------------------------------- node fan-out agent

class NodeFanoutAgent(BaseAgent):
    """按拓扑依赖分批，并行生成节点内容；以 tutor_event 事件流式回报进度。"""

    node_model: str = NODE_MODEL
    _client: Any = None

    def model_post_init(self, __context: Any) -> None:
        self._client = genai.Client()

    async def _gen_node(self, node: dict, parent_hooks: list[str], file_part: types.Part, lang_instruction: str) -> dict:
        for attempt, prompt in enumerate(
            [build_node_prompt(node, parent_hooks, lang_instruction), build_node_prompt_retry(node, lang_instruction)]
        ):
            try:
                resp = await self._client.aio.models.generate_content(
                    model=self.node_model,
                    contents=types.Content(
                        role="user",
                        parts=[file_part, types.Part(text=prompt)],
                    ),
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        response_schema=NodeContent,
                        max_output_tokens=8192,
                    ),
                )
                content = resp.parsed
                if content and content.coreConcepts:
                    return content.model_dump()
            except Exception as e:
                print(f"[fanout] node {node['id']} attempt {attempt} failed: {e}")
        return _stub_content(node)

    async def _run_async_impl(self, ctx: InvocationContext):
        lang_instruction = LANG_INSTRUCTIONS.get(ctx.session.state.get("lang", "zh"), "使用中文")
        file_uri = ctx.session.state.get("file_uri", "")

        async def emit(payload: dict):
            yield Event(
                invocation_id=ctx.invocation_id,
                author=self.name,
                content=types.Content(
                    role="model", parts=[types.Part(text=json.dumps({"tutor_event": payload}, ensure_ascii=False))]
                ),
            )

        # --- 读取并清洗骨架 ---
        raw = ctx.session.state.get("skeleton") or {}
        if isinstance(raw, str):
            raw = json.loads(raw)
        skeleton = {
            "nodes": [dict(n) for n in raw.get("nodes", [])],
            "edges": [
                {"from": e.get("from", e.get("from_", "")), "to": e.get("to", ""), "type": e.get("type", "hard"), "reason": e.get("reason", "")}
                for e in raw.get("edges", [])
            ],
        }
        if not skeleton["nodes"]:
            async for ev in emit({"type": "error", "source": "vertex", "message": "Invalid skeleton JSON from AI"}):
                yield ev
            return
        sanitize_skeleton(skeleton)
        async for ev in emit({"type": "skeleton_done", "data": skeleton}):
            yield ev

        file_part = types.Part.from_uri(file_uri=file_uri, mime_type="application/pdf")

        # --- 构建 hard 边拓扑 ---
        node_map = {n["id"]: n for n in skeleton["nodes"]}
        parent_map: dict[str, list[str]] = {n["id"]: [] for n in skeleton["nodes"]}
        children_map: dict[str, list[str]] = {n["id"]: [] for n in skeleton["nodes"]}
        in_degree: dict[str, int] = {n["id"]: 0 for n in skeleton["nodes"]}
        for e in skeleton["edges"]:
            if e["type"] == "hard" and e["from"] in node_map and e["to"] in node_map:
                parent_map[e["to"]].append(e["from"])
                children_map[e["from"]].append(e["to"])
                in_degree[e["to"]] += 1

        # --- 依赖感知批处理 ---
        content_map: dict[str, dict] = {}

        async def gen_and_report(nodes_to_gen):
            tasks = []
            for node in nodes_to_gen:
                hooks = [content_map[pid]["exitHook"] for pid in parent_map.get(node["id"], []) if pid in content_map]
                tasks.append(self._gen_node(node, hooks, file_part, lang_instruction))
                async for ev in emit({"type": "node_start", "nodeId": node["id"], "name": node["name"]}):
                    yield ev
            results = await asyncio.gather(*tasks)
            for node, content in zip(nodes_to_gen, results):
                content_map[node["id"]] = content
                async for ev in emit({"type": "node_done", "nodeId": node["id"], "data": content}):
                    yield ev

        while True:
            batch = select_batch_nodes(skeleton["nodes"], in_degree, parent_map, content_map)
            if not batch:
                break
            async for ev in gen_and_report(batch):
                yield ev
            for node in batch:
                for child in children_map.get(node["id"], []):
                    in_degree[child] -= 1

        # 孤立节点兜底
        remaining = [n for n in skeleton["nodes"] if n["id"] not in content_map]
        if remaining:
            async for ev in gen_and_report(remaining):
                yield ev

        async for ev in emit({"type": "agent_done"}):
            yield ev


node_fanout_agent = NodeFanoutAgent(name="node_fanout_agent")

root_agent = SequentialAgent(
    name="tutor_workflow",
    sub_agents=[skeleton_agent, node_fanout_agent],
    before_agent_callback=initialize_state,
)

app = App(
    root_agent=root_agent,
    name="app",
)
