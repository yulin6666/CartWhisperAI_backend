-- 更新全局配额为1000万tokens
UPDATE "GlobalQuota" 
SET "dailyTokenQuota" = 10000000, 
    "tokensUsedToday" = 0,
    "quotaResetDate" = CURRENT_DATE,
    "updatedAt" = NOW()
WHERE "id" = 'global';

-- 查看更新后的结果
SELECT * FROM "GlobalQuota" WHERE "id" = 'global';
