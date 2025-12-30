const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
const PORT = process.env.PORT || 3000;

// ============ 初始化数据库 ============
async function initDatabase() {
  console.log('[DB] Initializing...');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "Shop" (
        "id" TEXT PRIMARY KEY,
        "domain" TEXT UNIQUE NOT NULL,
        "apiKey" TEXT UNIQUE NOT NULL,
        "createdAt" TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "Shop_apiKey_idx" ON "Shop"("apiKey")`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "Product" (
        "id" TEXT PRIMARY KEY,
        "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE,
        "productId" TEXT NOT NULL,
        "handle" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "description" TEXT,
        "productType" TEXT,
        "vendor" TEXT,
        "price" FLOAT NOT NULL,
        "image" TEXT,
        "tags" TEXT[],
        "createdAt" TIMESTAMP DEFAULT NOW(),
        UNIQUE("shopId", "productId")
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "Recommendation" (
        "id" TEXT PRIMARY KEY,
        "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE,
        "sourceId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
        "targetId" TEXT NOT NULL REFERENCES "Product"("id") ON DELETE CASCADE,
        "reason" TEXT,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        UNIQUE("shopId", "sourceId", "targetId")
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "Rec_sourceId_idx" ON "Recommendation"("sourceId")`);

    console.log('[DB] Ready');
  } finally {
    client.release();
  }
}

// Middleware
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const syncLimiter = rateLimit({ windowMs: 60000, max: 10 });
const queryLimiter = rateLimit({ windowMs: 60000, max: 300 });

const cache = new Map();
const CACHE_TTL = 300000;

// ============ Auth ============
async function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

  const result = await pool.query('SELECT * FROM "Shop" WHERE "apiKey" = $1', [apiKey]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid API key' });

  req.shop = result.rows[0];
  next();
}

// ============ DeepSeek AI ============
async function callDeepSeek(prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是电商推荐专家。返回JSON，包含recommendations数组，每个元素有productId和reason。reason简短15字内。只返回JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
  } catch (e) {
    console.error('[AI] Error:', e.message);
    return null;
  }
}

// 判断是否是同款产品（基于 handle 前缀）
function isSameProduct(product1, product2) {
  if (!product1.handle || !product2.handle) return false;

  // 提取 handle 的主要部分（去掉颜色/尺寸后缀）
  const normalize = (handle) => {
    // 移除末尾的颜色或尺寸相关的部分，如 -white, -black, -s, -m, -l 等
    return handle.replace(/-[a-z0-9]*$/, '').toLowerCase();
  };

  return normalize(product1.handle) === normalize(product2.handle);
}

async function generateRecommendations(products, allProducts = null) {
  // products: 需要生成推荐的商品
  // allProducts: 所有可选的推荐目标商品（如果为空，则使用 products）
  const targetPool = allProducts || products;
  const results = [];

  for (const product of products) {
    // 过滤：
    // 1. 排除相同 ID 的产品
    // 2. 排除同款产品（基于 handle）
    // 3. 排除同类型的产品（基于 productType）- 不推荐同类商品
    const others = targetPool.filter(p =>
      p.productId !== product.productId &&
      !isSameProduct(product, p) &&
      (product.productType || '').toLowerCase() !== (p.productType || '').toLowerCase()
    );
    if (others.length === 0) continue;

    const prompt = `你是电商推荐专家。请为以下商品推荐3个最佳搭配产品。

商品: ${product.title}
类型: ${product.productType || '未分类'}
价格: ¥${product.price}

可选搭配商品:
${others.map((p, i) => `${i + 1}. ID:${p.productId} ${p.title} (¥${p.price})`).join('\n')}

请返回JSON格式，包含3个推荐。每个推荐需要包含:
- productId: 推荐商品的ID
- reason: 推荐理由（中英双语，格式："中文理由|English reason"）

只返回JSON，不要其他内容:
{"recommendations":[{"productId":"xxx","reason":"中文理由|English reason"}]}`;

    const aiRes = await callDeepSeek(prompt);
    if (aiRes) {
      try {
        const json = aiRes.match(/\{[\s\S]*\}/)?.[0];
        const parsed = JSON.parse(json);
        const seen = new Set(); // 避免重复推荐
        for (const rec of (parsed.recommendations || []).slice(0, 3)) {
          const productId = String(rec.productId);
          if (seen.has(productId)) continue;

          const target = others.find(p => p.productId === productId);
          if (target) {
            seen.add(productId);
            results.push({
              sourceId: product.productId,
              targetId: target.productId,
              reason: rec.reason || '推荐搭配|Recommended pairing'
            });
          }
        }
      } catch (e) {
        console.error('[AI] Parse error:', e.message);
      }
    } else {
      // Fallback: 推荐不同类型的商品（others 已经过滤了同类）
      if (others.length > 0) {
        others.slice(0, 3).forEach(t => {
          results.push({
            sourceId: product.productId,
            targetId: t.productId,
            reason: '完美搭配|Perfect match'
          });
        });
      }
    }
    if (process.env.DEEPSEEK_API_KEY) await new Promise(r => setTimeout(r, 200));
  }
  return results;
}

// ============ Routes ============

// 商店注册 - 自动获取 API Key
app.post('/api/shops/register', async (req, res) => {
  try {
    const { domain } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain required' });

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 检查是否已存在
    const existing = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (existing.rows.length > 0) {
      return res.json({
        success: true,
        apiKey: existing.rows[0].apiKey,
        isNew: false,
        message: 'Shop already registered'
      });
    }

    // 生成新的 API Key
    const apiKey = `cw_${crypto.randomUUID().replace(/-/g, '')}`;
    const shopId = `shop_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    await pool.query(
      'INSERT INTO "Shop" ("id", "domain", "apiKey", "createdAt") VALUES ($1, $2, $3, NOW())',
      [shopId, cleanDomain, apiKey]
    );

    console.log(`[Register] New shop: ${cleanDomain}`);
    res.json({
      success: true,
      apiKey,
      isNew: true,
      message: 'Shop registered successfully'
    });
  } catch (e) {
    console.error('[Register] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', ai: !!process.env.DEEPSEEK_API_KEY });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/products/sync', syncLimiter, auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { products, regenerate } = req.body; // regenerate=true 强制重新生成所有推荐
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'Products required' });

    const shopId = req.shop.id;
    console.log(`[Sync] ${req.shop.domain}: ${products.length} products, regenerate=${!!regenerate}`);

    const saved = [];
    for (const p of products) {
      const productId = p.id.replace('gid://shopify/Product/', '');
      const id = crypto.randomUUID();

      await client.query(`
        INSERT INTO "Product" ("id", "shopId", "productId", "handle", "title", "description", "productType", "vendor", "price", "image", "tags")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT ("shopId", "productId") DO UPDATE SET
          "handle" = $4, "title" = $5, "description" = $6, "productType" = $7, "vendor" = $8, "price" = $9, "image" = $10, "tags" = $11
        RETURNING *
      `, [id, shopId, productId, p.handle, p.title, p.description || null, p.productType || null, p.vendor || null, parseFloat(p.price) || 0, p.image?.url || null, p.tags || []]);

      const result = await client.query('SELECT * FROM "Product" WHERE "shopId" = $1 AND "productId" = $2', [shopId, productId]);
      saved.push(result.rows[0]);
    }

    // 找出没有推荐的商品
    let productsNeedingRecs = saved;
    if (!regenerate) {
      const existingRecs = await client.query(
        'SELECT DISTINCT "sourceId" FROM "Recommendation" WHERE "shopId" = $1',
        [shopId]
      );
      const existingSourceIds = new Set(existingRecs.rows.map(r => r.sourceId));
      productsNeedingRecs = saved.filter(p => !existingSourceIds.has(p.id));
      console.log(`[Sync] ${productsNeedingRecs.length} products need new recommendations`);
    } else {
      // 如果强制重新生成，先删除所有旧推荐
      await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
      console.log(`[Sync] Regenerating all recommendations...`);
    }

    let count = 0;
    if (productsNeedingRecs.length > 0) {
      console.log(`[Sync] Generating recommendations for ${productsNeedingRecs.length} products...`);
      const recs = await generateRecommendations(productsNeedingRecs, saved);

      for (const rec of recs) {
        const src = saved.find(p => p.productId === rec.sourceId);
        const tgt = saved.find(p => p.productId === rec.targetId);
        if (src && tgt) {
          // 使用 ON CONFLICT 避免重复插入
          await client.query(`
            INSERT INTO "Recommendation" ("id", "shopId", "sourceId", "targetId", "reason")
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT ("shopId", "sourceId", "targetId") DO UPDATE SET "reason" = $5
          `, [crypto.randomUUID(), shopId, src.id, tgt.id, rec.reason]);
          count++;
        }
      }
    }

    // 获取总推荐数
    const totalRecs = await client.query('SELECT COUNT(*) FROM "Recommendation" WHERE "shopId" = $1', [shopId]);

    console.log(`[Sync] Done: ${saved.length} products, ${count} new recommendations, ${totalRecs.rows[0].count} total`);
    cache.clear();
    res.json({
      success: true,
      products: saved.length,
      newRecommendations: count,
      totalRecommendations: parseInt(totalRecs.rows[0].count)
    });
  } catch (e) {
    console.error('[Sync] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 公开推荐接口（供 Theme Extension 使用，通过 shop 参数识别）
app.get('/api/storefront/recommendations', queryLimiter, async (req, res) => {
  // CORS 头
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { shop, product_id, limit: limitParam } = req.query;
    if (!shop || !product_id) {
      return res.status(400).json({ error: 'Missing shop or product_id parameter' });
    }

    const limit = Math.min(parseInt(limitParam) || 3, 10);

    // 通过 shop domain 查找商店
    const cleanDomain = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopResult = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (shopResult.rows.length === 0) {
      return res.json({ productId: product_id, recommendations: [] });
    }

    const shopId = shopResult.rows[0].id;

    // 查找商品
    const srcRes = await pool.query(
      'SELECT * FROM "Product" WHERE "shopId" = $1 AND ("productId" = $2 OR "handle" = $2)',
      [shopId, product_id]
    );
    if (!srcRes.rows.length) {
      return res.json({ productId: product_id, recommendations: [] });
    }

    // 获取推荐
    const recs = await pool.query(`
      SELECT r.*, p."productId", p."handle", p."title", p."price", p."image"
      FROM "Recommendation" r
      JOIN "Product" p ON r."targetId" = p."id"
      WHERE r."shopId" = $1 AND r."sourceId" = $2
      LIMIT $3
    `, [shopId, srcRes.rows[0].id, limit]);

    res.json({
      productId: product_id,
      recommendations: recs.rows.map(r => ({
        id: r.productId,
        handle: r.handle,
        title: r.title,
        price: r.price,
        image: r.image,
        reason: r.reason
      }))
    });
  } catch (e) {
    console.error('[Storefront] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ 管理 API ============

// 查询商店的所有推荐
app.get('/api/recommendations', queryLimiter, auth, async (req, res) => {
  try {
    const shopId = req.shop.id;
    const limit = parseInt(req.query.limit) || 999999;
    const offset = parseInt(req.query.offset) || 0;

    // 获取商品数量
    const productCount = await pool.query(
      'SELECT COUNT(*) FROM "Product" WHERE "shopId" = $1',
      [shopId]
    );

    // 获取推荐数量
    const recCount = await pool.query(
      'SELECT COUNT(*) FROM "Recommendation" WHERE "shopId" = $1',
      [shopId]
    );

    // 获取所有推荐（按源商品分组）
    const recs = await pool.query(`
      SELECT
        sp."productId" as "sourceProductId",
        sp."title" as "sourceTitle",
        sp."image" as "sourceImage",
        tp."productId" as "targetProductId",
        tp."title" as "targetTitle",
        tp."image" as "targetImage",
        r."reason",
        r."createdAt"
      FROM "Recommendation" r
      JOIN "Product" sp ON r."sourceId" = sp."id"
      JOIN "Product" tp ON r."targetId" = tp."id"
      WHERE r."shopId" = $1
      ORDER BY sp."productId", r."createdAt"
      LIMIT $2 OFFSET $3
    `, [shopId, limit, offset]);

    res.json({
      shop: req.shop.domain,
      stats: {
        products: parseInt(productCount.rows[0].count),
        recommendations: parseInt(recCount.rows[0].count)
      },
      recommendations: recs.rows,
      pagination: { limit, offset, returned: recs.rows.length }
    });
  } catch (e) {
    console.error('[Admin] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 删除商店的所有推荐
app.delete('/api/recommendations', auth, async (req, res) => {
  try {
    const shopId = req.shop.id;
    const result = await pool.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
    console.log(`[Admin] Deleted ${result.rowCount} recommendations for ${req.shop.domain}`);
    cache.clear();
    res.json({ success: true, deleted: result.rowCount });
  } catch (e) {
    console.error('[Admin] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// 删除商店的所有商品和推荐
app.delete('/api/products', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const shopId = req.shop.id;

    // 先删除推荐（外键约束）
    const recResult = await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
    // 再删除商品
    const prodResult = await client.query('DELETE FROM "Product" WHERE "shopId" = $1', [shopId]);

    console.log(`[Admin] Deleted ${prodResult.rowCount} products and ${recResult.rowCount} recommendations for ${req.shop.domain}`);
    cache.clear();
    res.json({
      success: true,
      deleted: {
        products: prodResult.rowCount,
        recommendations: recResult.rowCount
      }
    });
  } catch (e) {
    console.error('[Admin] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/recommendations/:productId', queryLimiter, auth, async (req, res) => {
  try {
    const shopId = req.shop.id;
    const { productId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 3, 10);

    const cacheKey = `${shopId}:${productId}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) return res.json(cached.data);

    const srcRes = await pool.query(
      'SELECT * FROM "Product" WHERE "shopId" = $1 AND ("productId" = $2 OR "handle" = $2)',
      [shopId, productId]
    );
    if (!srcRes.rows.length) return res.json({ productId, recommendations: [] });

    const recs = await pool.query(`
      SELECT r.*, p."productId", p."handle", p."title", p."price", p."image"
      FROM "Recommendation" r
      JOIN "Product" p ON r."targetId" = p."id"
      WHERE r."shopId" = $1 AND r."sourceId" = $2
      LIMIT $3
    `, [shopId, srcRes.rows[0].id, limit]);

    const data = {
      productId,
      recommendations: recs.rows.map(r => ({
        id: r.productId,
        handle: r.handle,
        title: r.title,
        price: r.price,
        image: r.image,
        reason: r.reason
      }))
    };

    cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL });
    res.json(data);
  } catch (e) {
    console.error('[Query] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ Start ============
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`AI: ${process.env.DEEPSEEK_API_KEY ? 'ON' : 'OFF'}`);
  });
}).catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
