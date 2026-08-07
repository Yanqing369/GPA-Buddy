# ruff: noqa
# GPA Buddy 测验 Agent —— 与 agent/quiz_agent 本地演示版共用同一套工具实现。
# 聊天指令驱动：Moodle 导入 / 文件上传 → 调 worker 出题 → A2UI 测验界面 → 记录错题 → 错题再出题。
# 后端复用 Cloudflare Worker（https://moyuxiaowu.org），工具层见 app/tools.py。

import os

from google.adk.agents import Agent
from google.adk.apps import App

from . import tools


def _build_model():
    """默认 gemini-2.5-flash；设 AGENT_MODEL=deepseek/deepseek-chat 等可经 LiteLLM 换模型。"""
    name = os.environ.get("AGENT_MODEL", "gemini-2.5-flash")
    if "/" in name:  # LiteLLM 形式，如 deepseek/deepseek-chat
        from google.adk.models.lite_llm import LiteLlm
        return LiteLlm(model=name)
    return name


INSTRUCTION = """你是 GPA Buddy 测验助手，帮助用户把课程资料变成选择题练习，并围绕错题循环巩固。

工作循环（根据用户的聊天指令自主规划步骤）：
1. 获取资料：用户想从 Moodle 导入时，先 list_moodle_courses 列出课程，确认后 import_moodle_course；
   用户给了本地文件路径时，用 list_my_courses / create_course 准备课程，再 upload_material 上传
   （仅支持 .pdf/.txt/.md）。
2. 出题：用 list_materials 确认资料 id，然后 generate_quiz 生成题目，成功后必须立即调用
   present_quiz 把测验界面展示给用户（不要自己把题目逐条打在聊天里，除非用户明确要求）。
3. 判分：用户作答后，客户端会发来一条以 [QUIZ_ANSWERS] 开头、后接 JSON 的消息，
   把 JSON 解析成 dict 调用 grade_quiz。判分后简要汇报得分和错题解析要点，错题会自动写入错题本。
4. 再出题：用户想巩固时，用 list_mistakes 查看错题本，或 generate_quiz_from_mistakes 直接根据
   错题出新题，成功后同样立即 present_quiz。错题重练后再判分，形成循环。

规则：
- 任何工具返回"尚未登录"时，引导用户点击页面右上角「Google 登录」，不要反复重试。
- 出题数量默认 20 题，语言默认中文(zh)，除非用户另有要求。
- 导入 Moodle 课程后，主动告诉用户课程里有哪些文件，并询问是否直接出题（用户说"直接出"就别再问）。
- 回复用中文，简洁，不要复述工具返回的原始 JSON。
- generate_quiz / generate_quiz_from_mistakes 成功后必须调用 present_quiz，这一步不能省。
"""

root_agent = Agent(
    name="quiz_agent",
    model=_build_model(),
    description="从 Moodle 或本地文件生成选择题测验，记录错题并针对错题再出题的练习助手。",
    instruction=INSTRUCTION,
    tools=[
        tools.check_login,
        tools.list_moodle_courses,
        tools.import_moodle_course,
        tools.list_my_courses,
        tools.create_course,
        tools.list_materials,
        tools.upload_material,
        tools.generate_quiz,
        tools.present_quiz,
        tools.grade_quiz,
        tools.list_mistakes,
        tools.generate_quiz_from_mistakes,
    ],
)

app = App(
    root_agent=root_agent,
    name="app",
)
