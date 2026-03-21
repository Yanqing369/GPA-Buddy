# 强制系统使用UTF-8编码，解决Windows中文乱码问题
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 导入FastAPI框架，用来建网站接口
from fastapi import FastAPI
# 导入异步HTTP客户端，用来调用DeepSeek
import httpx
# 导入配置信息（密钥和地址）
from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL
# 导入跨域支持，让前端能访问后端
from fastapi.middleware.cors import CORSMiddleware
# 导入Pydantic，用来验证数据格式
from pydantic import BaseModel
# 导入JSON处理，用来打包和解包数据
import json
# 导入traceback，用来打印详细错误信息
import traceback
# 导入asyncio用于并发
import asyncio

# 创建FastAPI应用实例，这就是我们的网站
app = FastAPI()

# 允许所有来源访问（开发时方便，生产环境要限制）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 星号表示允许任何网址
    allow_credentials=True,  # 允许带cookie
    allow_methods=["*"],  # 允许所有HTTP方法（GET/POST等）
    allow_headers=["*"],  # 允许所有请求头
)

# 定义请求数据格式，前端发来的必须包含messages字段
class ChatRequest(BaseModel):
    messages: list  # 这是对话历史列表

# 批量请求格式
class BatchItem(BaseModel):
    chunk_id: int
    messages: list

class BatchChatRequest(BaseModel):
    items: list[BatchItem]

# 调试打印函数，带刷新确保立即显示
def debug_print(msg):
    print(msg, flush=True)  # flush=True确保立即输出到控制台

# 读取计数文件，返回当前数字
# 文件不存在就返回0
def read_count():
    try:  # 尝试打开文件
        debug_print(f"尝试读取计数文件，使用UTF-8编码...")
        with open("count.txt", "r", encoding='utf-8') as f:  # 明确指定UTF-8编码
            content = f.read().strip()  # 读取并去除空白
            debug_print(f"读取成功，内容: '{content}'")
            return int(content)  # 转成整数
    except FileNotFoundError:  # 如果文件不存在
        debug_print("计数文件不存在，返回0")
        return 0
    except Exception as e:  # 其他错误
        debug_print(f"读计数文件出错: {str(e)}")
        return 0

# 写入计数文件，把数字存进去
# number参数是要写的整数
def write_count(number):
    try:
        debug_print(f"尝试写入计数: {number}，使用UTF-8编码...")
        with open("count.txt", "w", encoding='utf-8') as f:  # 明确指定UTF-8编码
            f.write(str(number))  # 把数字转成字符串写进去
        debug_print(f"写入成功")
    except Exception as e:
        debug_print(f"写计数文件出错: {str(e)}")
        debug_print(f"错误详情: {traceback.format_exc()}")

# 增加计数，读出来+1再写回去
def increment_count():
    debug_print("开始增加计数...")
    current = read_count()  # 先读当前值
    new_count = current + 1
    write_count(new_count)  # 加1后写回
    debug_print(f"计数从 {current} 增加到 {new_count}")
    return new_count

# 单次调用DeepSeek的辅助函数
async def call_deepseek(messages: list, chunk_id: int = None):
    """并发调用DeepSeek的辅助函数"""
    payload = {
        "model": "deepseek-chat",
        "messages": messages,
        "stream": False,
        "temperature": 0.7
    }
    
    headers = {
        "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
        "Content-Type": "application/json; charset=utf-8"
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{DEEPSEEK_BASE_URL}/chat/completions",
            json=payload,
            headers=headers,
            timeout=120.0
        )
        
        response.encoding = 'utf-8'
        
        if response.status_code != 200:
            error_text = response.text
            raise Exception(f"Chunk {chunk_id}: AI服务出错，状态码：{response.status_code}")
        
        return response.json()

# 健康检查接口，浏览器访问这个看服务是否正常
# 返回pong表示活着
@app.get("/ping")
def ping():
    debug_print("收到ping请求")
    return {"status": "pong"}  # pong是乒乓球的乓，表示活着

# 统计接口，返回总生成次数
# 前端页面加载时调用这个
@app.get("/stats")
def stats():
    debug_print("收到stats请求")
    try:
        count = read_count()  # 读取当前计数
        debug_print(f"返回统计: {count}")
        return {"total": count}  # 包装成JSON返回
    except Exception as e:
        debug_print(f"stats出错: {str(e)}")
        return {"total": 0, "error": str(e)}

# 原单条聊天接口（保持兼容）
@app.post("/chat")
async def chat(request: ChatRequest):
    debug_print(f"收到chat请求，消息数: {len(request.messages)}")
    
    try:
        # 计数加1
        current_count = increment_count()
        
        result = await call_deepseek(request.messages)
        return result
            
    except Exception as e:
        error_detail = traceback.format_exc()
        debug_print(f"发生异常: {str(e)}")
        return {"error": str(e)}

# 新增：批量聊天接口，同时处理多个分段
@app.post("/chat/batch")
async def chat_batch(request: BatchChatRequest):
    debug_print(f"收到批量chat请求，共 {len(request.items)} 个分段")
    
    # 计数只加1次（算作一次生成操作）
    increment_count()
    
    async def process_single(item: BatchItem):
        """处理单个分段的协程"""
        try:
            debug_print(f"开始处理 chunk {item.chunk_id}")
            result = await call_deepseek(item.messages, item.chunk_id)
            debug_print(f"完成 chunk {item.chunk_id}")
            return {
                "chunk_id": item.chunk_id,
                "success": True,
                "data": result
            }
        except Exception as e:
            debug_print(f"chunk {item.chunk_id} 失败: {str(e)}")
            return {
                "chunk_id": item.chunk_id,
                "success": False,
                "error": str(e)
            }
    
    try:
        # 使用 asyncio.gather 同时处理所有分段
        # 这行代码就是让后端"同时"POST给AI的关键
        results = await asyncio.gather(*[
            process_single(item) for item in request.items
        ])
        
        # 检查是否有失败的
        failed = [r for r in results if not r["success"]]
        if failed:
            debug_print(f"有 {len(failed)} 个分段处理失败")
        
        return {
            "total": len(results),
            "successful": len([r for r in results if r["success"]]),
            "failed": len(failed),
            "results": results
        }
        
    except Exception as e:
        debug_print(f"批量处理异常: {str(e)}")
        return {"error": str(e)}

# 启动时打印信息
debug_print("="*50)
debug_print("FastAPI服务正在启动...")
debug_print(f"Python版本: {sys.version}")
debug_print(f"默认编码: {sys.getdefaultencoding()}")
debug_print(f"当前工作目录: {sys.path[0]}")
debug_print("="*50)