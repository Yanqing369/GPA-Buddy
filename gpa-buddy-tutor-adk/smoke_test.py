# 本地冒烟测试：完整跑一遍 tutor workflow（skeleton -> 并行节点生成）
# 用法: .venv/Scripts/python smoke_test.py
import asyncio
import json
import os
import sys

os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
os.environ.setdefault("GOOGLE_CLOUD_PROJECT", "gpa-490510")
os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "us-west1")

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from app.agent import app

FILE_URI = "gs://gpa-buddy-asia/test-tutor-adk-smoke.pdf"


async def main():
    session_service = InMemorySessionService()
    runner = Runner(app=app, session_service=session_service)
    session = await session_service.create_session(app_name="app", user_id="smoke")

    msg = types.Content(
        role="user",
        parts=[
            types.Part.from_uri(file_uri=FILE_URI, mime_type="application/pdf"),
            types.Part(text=json.dumps({"lang": "zh", "custom_prompt": "", "file_uri": FILE_URI})),
        ],
    )

    n_events = 0
    async for ev in runner.run_async(user_id="smoke", session_id=session.id, new_message=msg):
        if not (ev.content and ev.content.parts):
            continue
        for p in ev.content.parts:
            if not p.text:
                continue
            n_events += 1
            try:
                obj = json.loads(p.text)
                if "tutor_event" in obj:
                    te = obj["tutor_event"]
                    t = te.get("type")
                    if t == "skeleton_done":
                        d = te["data"]
                        print(f"[skeleton_done] nodes={len(d['nodes'])} edges={len(d['edges'])}")
                        print("  node ids:", [n["id"] for n in d["nodes"]])
                    elif t == "node_done":
                        d = te["data"]
                        print(f"[node_done] {te['nodeId']}: concepts={len(d.get('coreConcepts', []))} exitHook={d.get('exitHook','')[:60]!r}")
                    else:
                        print(f"[{t}]", {k: v for k, v in te.items() if k != 'data'})
                else:
                    print(f"[{ev.author}] {p.text[:200]}")
            except ValueError:
                print(f"[{ev.author}] {p.text[:200]}")
    print("total text events:", n_events)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
