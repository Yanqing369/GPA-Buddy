"""本地桥接服务器：静态客户端 + ADK Runner SSE 桥。

运行：python server.py  （或 uvicorn server:app --port 8788）
然后浏览器打开 http://localhost:8788

登录态（worker JWT）/ Turnstile token / 当前测验都存进 ADK 会话的 state，
工具经 tool_context.state 读写——与云端 Agent Runtime 的按会话隔离是同一套代码路径。
"""

import asyncio
import json
import os
import pathlib
import uuid

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.events import Event, EventActions
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from quiz_agent.agent import root_agent

BASE = "https://moyuxiaowu.org"
CLIENT_DIR = pathlib.Path(__file__).parent / "client"
USER_ID = "local"
SESSION_ID = "default"

app = FastAPI(title="GPA Buddy Quiz Agent")
session_service = InMemorySessionService()
runner = Runner(agent=root_agent, app_name="quiz_agent", session_service=session_service)
_session_ready = asyncio.Event()


async def _get_state() -> dict:
    """读本地演示会话的 state（get_session 返回拷贝，只读没问题）。"""
    sess = await session_service.get_session(
        app_name="quiz_agent", user_id=USER_ID, session_id=SESSION_ID)
    return sess.state


async def _set_state(**values):
    """写会话 state：经 append_event + state_delta，保证真正落进会话存储
    （get_session 返回的是深拷贝，直接改不会生效）。"""
    sess = await session_service.get_session(
        app_name="quiz_agent", user_id=USER_ID, session_id=SESSION_ID)
    event = Event(author="quiz_agent", invocation_id=uuid.uuid4().hex,
                  actions=EventActions(state_delta=values))
    await session_service.append_event(sess, event)


@app.on_event("startup")
async def _init_session():
    await session_service.create_session(app_name="quiz_agent", user_id=USER_ID, session_id=SESSION_ID)
    # 可选：QUIZ_AGENT_SEED_QUIZ=<json文件> 预置一套演示题目（用于无登录演示/测试 A2UI 链路）
    seed = os.environ.get("QUIZ_AGENT_SEED_QUIZ")
    if seed and pathlib.Path(seed).exists():
        data = json.loads(pathlib.Path(seed).read_text(encoding="utf-8"))
        await _set_state(quiz={"course_id": None, "title": data.get("title", "演示测验"),
                               "questions": data["questions"]})
    _session_ready.set()


@app.post("/api/session")
async def set_session(req: Request):
    """客户端登录后注入 worker JWT。"""
    body = await req.json()
    token = (body.get("token") or "").strip()
    if not token:
        return JSONResponse({"error": "missing token"}, status_code=400)
    resp = httpx.get(f"{BASE}/auth/me", headers={"Authorization": f"Bearer {token}"}, timeout=15)
    if resp.status_code != 200:
        return JSONResponse({"error": "token 无效或已过期"}, status_code=401)
    await _set_state(token=token)
    user = resp.json()
    return {"ok": True, "user": {"name": user.get("name"), "email": user.get("email")}}


@app.post("/api/turnstile")
async def set_turnstile(req: Request):
    """客户端 Turnstile widget 推送最新 token。"""
    body = await req.json()
    token = (body.get("token") or "").strip() or None
    await _set_state(turnstile=token)
    return {"ok": bool(token)}


@app.get("/api/status")
async def status():
    state = await _get_state()
    return {"logged_in": bool(state.get("token")), "turnstile": bool(state.get("turnstile"))}


UPLOAD_DIR = pathlib.Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)


@app.post("/api/upload")
async def upload(req: Request):
    """接收浏览器上传的文件，保存到 agent/uploads/，返回本地路径供 agent 使用。"""
    form = await req.form()
    f = form.get("file")
    if not f or not f.filename:
        return JSONResponse({"error": "no file"}, status_code=400)
    dest = UPLOAD_DIR / pathlib.Path(f.filename).name
    dest.write_bytes(await f.read())
    return {"ok": True, "path": str(dest), "name": f.filename}


@app.post("/api/chat")
async def chat(req: Request):
    body = await req.json()
    message = (body.get("message") or "").strip()
    if not message:
        return JSONResponse({"error": "empty message"}, status_code=400)
    await _session_ready.wait()

    async def event_stream():
        content = types.Content(role="user", parts=[types.Part(text=message)])
        streamed = False  # 本轮是否已推过 partial 文本（final 事件带全量文本，需去重）
        try:
            async for event in runner.run_async(
                user_id=USER_ID, session_id=SESSION_ID, new_message=content,
                run_config=RunConfig(streaming_mode=StreamingMode.SSE),
            ):
                if not event.content or not event.content.parts:
                    continue
                for part in event.content.parts:
                    if part.text and not part.thought:
                        if event.partial:
                            streamed = True
                            yield f"data: {json.dumps({'type': 'text', 'data': part.text}, ensure_ascii=False)}\n\n"
                        elif streamed:
                            streamed = False  # final 全量文本与已推的增量重复，跳过
                        else:
                            yield f"data: {json.dumps({'type': 'text', 'data': part.text}, ensure_ascii=False)}\n\n"
                    elif part.function_response:
                        resp = part.function_response.response
                        if isinstance(resp, dict) and isinstance(resp.get("result"), dict):
                            resp = resp["result"]
                        if isinstance(resp, dict) and "a2ui_messages" in resp:
                            yield f"data: {json.dumps({'type': 'a2ui', 'messages': resp['a2ui_messages']}, ensure_ascii=False)}\n\n"
                        else:
                            yield f"data: {json.dumps({'type': 'tool', 'name': part.function_response.name}, ensure_ascii=False)}\n\n"
        except Exception as e:  # noqa: BLE001 - 把错误透传给前端
            yield f"data: {json.dumps({'type': 'error', 'data': str(e)}, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/")
@app.get("/index.html")
async def index():
    # worker Google 登录回调会跳到 /index.html?login=success&token=...，由页面脚本捕获
    return FileResponse(CLIENT_DIR / "index.html")


app.mount("/static", StaticFiles(directory=CLIENT_DIR), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8788)
