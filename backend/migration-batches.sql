-- =====================================
-- 题目批次表迁移
-- 每次解析生成一组题目窗口，名称为资料名
-- =====================================

CREATE TABLE IF NOT EXISTS course_question_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    course_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
);

ALTER TABLE course_questions ADD COLUMN batch_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_batches_course_id ON course_question_batches(course_id);
CREATE INDEX IF NOT EXISTS idx_questions_batch_id ON course_questions(batch_id);
