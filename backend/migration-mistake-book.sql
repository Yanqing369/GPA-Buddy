-- =====================================
-- 错题本：标记题库类型（NULL=普通题库，'mistake'=课程共享错题本）
-- =====================================

ALTER TABLE question_banks ADD COLUMN bank_type TEXT;

-- .schema question_banks
