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

async function generateRecommendations(products) {
  const results = [];
  for (const product of products) {
    const others = products.filter(p => p.productId !== product.productId);
    if (others.length === 0) continue;

    const prompt = `商品: ${product.title} (${product.productType || '未分类'}, ¥${product.price})
候选:
${others.map((p, i) => `${i + 1}. ID:${p.productId} ${p.title}`).join('\n')}
选3个搭配商品，返回:{"recommendations":[{"productId":"xxx","reason":"理由"}]}`;

    const aiRes = await callDeepSeek(prompt);
    if (aiRes) {
      try {
        const json = aiRes.match(/\{[\s\S]*\}/)?.[0];
        const parsed = JSON.parse(json);
        for (const rec of (parsed.recommendations || []).slice(0, 3)) {
          const target = others.find(p => p.productId === String(rec.productId));
          if (target) results.push({ sourceId: product.productId, targetId: target.productId, reason: rec.reason || '' });
        }
      } catch (e) {}
    } else {
      // Fallback
      others.filter(p => p.productType === product.productType).slice(0, 3).forEach(t => {
        results.push({ sourceId: product.productId, targetId: t.productId, reason: '同类推荐' });
      });
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
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'Products required' });

    const shopId = req.shop.id;
    console.log(`[Sync] ${req.shop.domain}: ${products.length} products`);

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

    console.log(`[Sync] Generating recommendations...`);
    const recs = await generateRecommendations(saved);

    await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);

    let count = 0;
    for (const rec of recs) {
      const src = saved.find(p => p.productId === rec.sourceId);
      const tgt = saved.find(p => p.productId === rec.targetId);
      if (src && tgt) {
        await client.query(
          'INSERT INTO "Recommendation" ("id", "shopId", "sourceId", "targetId", "reason") VALUES ($1, $2, $3, $4, $5)',
          [crypto.randomUUID(), shopId, src.id, tgt.id, rec.reason]
        );
        count++;
      }
    }

    console.log(`[Sync] Done: ${saved.length} products, ${count} recommendations`);
    cache.clear();
    res.json({ success: true, products: saved.length, recommendations: count });
  } catch (e) {
    console.error('[Sync] Error:', e);
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
