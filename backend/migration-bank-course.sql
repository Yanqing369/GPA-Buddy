-- =====================================
-- 云题库关联课程：我的题目按课程过滤
-- =====================================

ALTER TABLE question_banks ADD COLUMN course_id INTEGER;

-- 回填：按源文件 r2_key 关联到课程（课程生成的题库）
UPDATE question_banks SET course_id = (
  SELECT course_id FROM course_materials
  WHERE course_materials.r2_key = question_banks.source_r2_key
) WHERE source_r2_key IS NOT NULL;

-- .schema question_banks
