-- CartWhisper AI Backend - Shop Setup Script
-- Run this in Railway PostgreSQL console to create your shop

-- Create shop record (modify values as needed)
INSERT INTO "Shop" (id, domain, "apiKey", "createdAt")
VALUES (
    'shop_001',                              -- Shop ID (unique identifier)
    'durian-sweet-hut.myshopify.com',        -- Your Shopify domain
    'cw_test_key_12345',                     -- Your API key (keep this secret!)
    NOW()
)
ON CONFLICT (domain) DO UPDATE SET
    "apiKey" = EXCLUDED."apiKey";

-- Verify the shop was created
SELECT * FROM "Shop";

-- Optional: View all products for a shop
-- SELECT * FROM "Product" WHERE "shopId" = 'shop_001';

-- Optional: View all recommendations for a shop
-- SELECT r.*,
--        s."title" as "sourceTitle",
--        t."title" as "targetTitle"
-- FROM "Recommendation" r
-- JOIN "Product" s ON r."sourceId" = s.id
-- JOIN "Product" t ON r."targetId" = t.id
-- WHERE r."shopId" = 'shop_001';

-- Optional: Delete all data for a shop
-- DELETE FROM "Shop" WHERE id = 'shop_001';
