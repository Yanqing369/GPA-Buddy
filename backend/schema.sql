-- =====================================
-- Exam Buddy 数据库初始化脚本
-- 在 Cloudflare D1 中执行
-- =====================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    avatar TEXT,
    google_id TEXT UNIQUE,
    wechat_id TEXT UNIQUE,
    -- 账户类型：free(免费), pro(专业版), premium(高级版)
    account_type TEXT DEFAULT 'free',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
);

-- 题库表
CREATE TABLE IF NOT EXISTS question_banks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    questions_count INTEGER DEFAULT 0,
    is_public BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 题目表
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id INTEGER NOT NULL,
    type TEXT DEFAULT 'choice',  -- choice(选择题), fill(填空题), essay(问答题), etc.
    content TEXT NOT NULL,       -- 题目内容（JSON格式，包含选项等）
    answer TEXT,                 -- 答案
    explanation TEXT,            -- 解析
    difficulty INTEGER DEFAULT 1,  -- 难度 1-5
    tags TEXT,                   -- 标签（JSON数组）
    source_file TEXT,            -- 来源文件名
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (bank_id) REFERENCES question_banks(id) ON DELETE CASCADE
);

-- 余额表
CREATE TABLE IF NOT EXISTS balances (
    user_id INTEGER PRIMARY KEY,
    amount INTEGER DEFAULT 0,           -- 余额（单位：分/点）
    free_quota_daily INTEGER DEFAULT 10, -- 每日免费额度
    free_quota_used INTEGER DEFAULT 0,  -- 今日已使用免费额度
    last_reset_date DATE,               -- 上次重置日期
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 交易记录表
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,  -- recharge(充值), consume(消费), refund(退款)
    amount INTEGER NOT NULL,  -- 正数=充值，负数=消费
    description TEXT,
    related_id TEXT,  -- 关联的订单ID或生成记录ID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 支付订单表
CREATE TABLE IF NOT EXISTS payment_orders (
    id TEXT PRIMARY KEY,  -- 订单号（UUID格式）
    user_id INTEGER NOT NULL,
    provider TEXT,  -- alipay, wechatpay
    amount INTEGER NOT NULL,  -- 支付金额（分）
    credits INTEGER NOT NULL, -- 获得的积分/点数
    status TEXT DEFAULT 'pending',  -- pending, paid, failed, cancelled
    paid_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_wechat_id ON users(wechat_id);
CREATE INDEX IF NOT EXISTS idx_banks_user_id ON question_banks(user_id);
CREATE INDEX IF NOT EXISTS idx_questions_bank_id ON questions(bank_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);

-- =====================================
-- 初始化数据（可选）
-- =====================================

-- 查看表结构
-- .tables
-- .schema users
