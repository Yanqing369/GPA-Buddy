# 单用户本地演示：模块级会话状态（server.py 与工具共享）
# 部署到云端时需改为按用户隔离的存储。
session = {
    "token": None,      # worker JWT（Google 登录后由客户端注入）
    "turnstile": None,  # 客户端 Turnstile widget 推送的最新 token
    "quiz": None,       # 当前测验 {"course_id": int|None, "title": str, "questions": [...]}
}
