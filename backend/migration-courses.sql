-- =====================================
-- 个人中心课程表迁移
-- 在 Cloudflare D1 中执行
-- =====================================

CREATE TABLE IF NOT EXISTS courses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS course_materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    type TEXT,
    content_text TEXT,           -- 用于 AI 生成的文本内容（仅文本资料）
    r2_key TEXT,                 -- R2 对象 key，原始文件存在 R2
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

-- 旧表迁移：如果 course_materials 已存在旧版 file_data 列，请手动执行：
-- ALTER TABLE course_materials ADD COLUMN r2_key TEXT;
-- ALTER TABLE course_materials DROP COLUMN file_data;

CREATE TABLE IF NOT EXISTS course_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    type TEXT DEFAULT 'choice',
    title TEXT,
    content TEXT NOT NULL,        -- 题干（JSON 格式，包含选项）
    answer TEXT,
    explanation TEXT,
    difficulty INTEGER DEFAULT 1,
    tags TEXT,                    -- JSON 数组
    source_material_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    FOREIGN KEY (source_material_id) REFERENCES course_materials(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_courses_user_id ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_course_materials_course_id ON course_materials(course_id);
CREATE INDEX IF NOT EXISTS idx_course_questions_course_id ON course_questions(course_id);
CREATE INDEX IF NOT EXISTS idx_course_questions_material_id ON course_questions(source_material_id);

-- .tables
-- .schema courses
-- .schema course_materials
-- .schema course_questions
