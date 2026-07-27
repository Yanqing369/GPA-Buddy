-- =====================================
-- 云端题库增加源文件信息，用于课程资料生成的题库溯源
-- =====================================

ALTER TABLE question_banks ADD COLUMN source_r2_key TEXT;
ALTER TABLE question_banks ADD COLUMN source_name TEXT;
ALTER TABLE question_banks ADD COLUMN source_type TEXT;
ALTER TABLE question_banks ADD COLUMN source_size INTEGER DEFAULT 0;

-- .schema question_banks
