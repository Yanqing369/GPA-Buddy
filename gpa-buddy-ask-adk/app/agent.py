# ruff: noqa
# GPA-Buddy「问 Gemini」答疑 Agent —— 与 backend/worker.js 的 handleAskGemini 保持同一套系统指令。
# 上下文（题干/选项/作答状态/对话记录/图片）由 Cloudflare Worker 拼装后以单条 user 消息转发，
# 因此本 Agent 无需工具，只负责生成讲解内容。

import os

from google.adk.agents import Agent
from google.adk.apps import App
from google.adk.models import Gemini
from google.genai import types


# 与现有直连链路默认模型一致，可用环境变量覆盖
MODEL = os.environ.get("ASK_MODEL_ID", "gemini-2.5-flash-lite")

SYSTEM_INSTRUCTION = "\n".join(
    [
        "你是一位耐心、专业的学习助教，正在帮助学生理解一道练习题。",
        "学生会附上最多两张图片：图1是当前练习界面的截图（包含题目和作答状态），图2是该题来源课件的页面渲染图（可能没有图2）。",
        "请结合图片和文字上下文回答学生的问题，重在讲解原理和思路，而不是只报答案。",
        "如果学生尚未提交答案，不要直接剧透正确答案，用引导式讲解。",
        "使用与学生相同的语言回答（默认中文），适当使用 Markdown 格式。",
    ]
)

root_agent = Agent(
    name="root_agent",
    model=Gemini(
        model=MODEL,
        retry_options=types.HttpRetryOptions(attempts=3),
    ),
    instruction=SYSTEM_INSTRUCTION,
)

app = App(
    root_agent=root_agent,
    name="app",
)
