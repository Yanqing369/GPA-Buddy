-- =====================================
-- 课程资料「已解析」标记迁移
-- 用于避免已生成过题目的资料被重复解析
-- =====================================

ALTER TABLE course_materials ADD COLUMN analyzed_at DATETIME;
