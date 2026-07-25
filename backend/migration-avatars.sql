-- 给现有无头像的邮箱用户补默认头像
UPDATE users SET avatar = '/resources/avatar1.png' WHERE avatar IS NULL AND google_id IS NULL;
