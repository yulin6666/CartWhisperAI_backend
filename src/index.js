const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

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

    // Migration: Add new columns to existing tables
    const addColumn = async (table, column, type, defaultVal) => {
      try {
        const def = defaultVal !== undefined ? ` DEFAULT ${defaultVal}` : '';
        await client.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" ${type}${def}`);
      } catch (e) { /* Column might exist */ }
    };

    // Shop table migrations
    await addColumn('Shop', 'plan', 'TEXT', "'free'");
    await addColumn('Shop', 'shopifySubscriptionId', 'TEXT', null);
    await addColumn('Shop', 'billingStatus', 'TEXT', "'active'");
    await addColumn('Shop', 'subscriptionStartedAt', 'TIMESTAMP', null);
    await addColumn('Shop', 'subscriptionEndsAt', 'TIMESTAMP', null);
    await addColumn('Shop', 'updatedAt', 'TIMESTAMP', null);
    // Sync tracking
    await addColumn('Shop', 'initialSyncDone', 'BOOLEAN', 'false');
    await addColumn('Shop', 'lastRefreshAt', 'TIMESTAMP', null);
    await addColumn('Shop', 'productCount', 'INTEGER', '0');
    // API usage tracking
    await addColumn('Shop', 'apiCallsToday', 'INTEGER', '0');
    await addColumn('Shop', 'apiCallsDate', 'DATE', null);

    // Recommendation tracking (impressions/clicks)
    await addColumn('Recommendation', 'impressions', 'INTEGER', '0');
    await addColumn('Recommendation', 'clicks', 'INTEGER', '0');

    await client.query(`CREATE INDEX IF NOT EXISTS "Shop_plan_idx" ON "Shop"("plan")`);

    console.log('[DB] Ready');
  } finally {
    client.release();
  }
}

// Middleware
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false })); // 允许内联脚本
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// 静态文件服务（测试面板）
app.use(express.static(path.join(__dirname, '..', 'public')));

const syncLimiter = rateLimit({ windowMs: 60000, max: 10 });
const queryLimiter = rateLimit({ windowMs: 60000, max: 300 });

const cache = new Map();
const CACHE_TTL = 300000;

// API 限额配置
const API_LIMITS = {
  free: 5000,   // 5,000 calls/day
  pro: 50000    // 50,000 calls/day
};

// ============ Auth ============
async function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

  const result = await pool.query('SELECT * FROM "Shop" WHERE "apiKey" = $1', [apiKey]);
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid API key' });

  req.shop = result.rows[0];
  next();
}

// API 限额检查和计数中间件
async function trackApiUsage(req, res, next) {
  const shop = req.shop;
  if (!shop) return next();

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const plan = shop.plan || 'free';
  const limit = API_LIMITS[plan] || API_LIMITS.free;

  // 检查是否是新的一天，重置计数
  let currentCalls = shop.apiCallsToday || 0;
  const lastDate = shop.apiCallsDate ? new Date(shop.apiCallsDate).toISOString().split('T')[0] : null;

  if (lastDate !== today) {
    // 新的一天，重置计数
    currentCalls = 0;
  }

  // 检查是否超过限额
  if (currentCalls >= limit) {
    return res.status(429).json({
      error: 'API rate limit exceeded',
      limit,
      used: currentCalls,
      plan,
      resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
    });
  }

  // 更新计数（异步，不阻塞响应）
  pool.query(`
    UPDATE "Shop" SET
      "apiCallsToday" = CASE WHEN "apiCallsDate" = $1::date THEN "apiCallsToday" + 1 ELSE 1 END,
      "apiCallsDate" = $1::date
    WHERE "id" = $2
  `, [today, shop.id]).catch(e => console.error('[API Usage] Update error:', e.message));

  // 添加响应头显示限额信息
  res.set('X-RateLimit-Limit', limit);
  res.set('X-RateLimit-Remaining', Math.max(0, limit - currentCalls - 1));
  res.set('X-RateLimit-Reset', new Date(new Date().setHours(24, 0, 0, 0)).toISOString());

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

  // 简化商品描述，提取关键信息
  const getGender = (p) => {
    const title = (p.title || '').toLowerCase();
    const type = (p.productType || '').toLowerCase();
    const tags = (p.tags || []).join(' ').toLowerCase();
    const all = title + ' ' + type + ' ' + tags;

    if (tags.match(/\bmens\b|filtergender:\s*mens/) || all.match(/\b(men'?s|male|boy)\b/) || type.includes('mens')) {
      return 'male';
    } else if (tags.match(/\bwomens\b|filtergender:\s*womens/) || all.match(/\b(women'?s|female|girl|ladies)\b/) || title.match(/dress|skirt|bra/i)) {
      return 'female';
    }
    return 'unisex';
  };

  const summarize = (p) => {
    const desc = (p.description || '').substring(0, 100).replace(/\s+/g, ' ');
    const title = p.title || '';
    const type = p.productType || '未分类';
    const gender = getGender(p);
    const genderLabel = gender === 'male' ? '[男士]' : gender === 'female' ? '[女士]' : '';
    return `${genderLabel}${title} [${type}] ${desc}`;
  };

  for (const product of products) {
    const productGender = getGender(product);

    // 过滤：排除同款、同ID、性别不匹配的商品
    const others = targetPool.filter(p => {
      if (p.productId === product.productId) return false;
      if (isSameProduct(product, p)) return false;

      // 性别过滤：男士商品不推荐女士商品，女士商品不推荐男士商品
      const targetGender = getGender(p);
      if (productGender === 'male' && targetGender === 'female') return false;
      if (productGender === 'female' && targetGender === 'male') return false;

      return true;
    });
    if (others.length === 0) continue;

    const prompt = `你是电商cross-sell推荐专家。请为以下商品推荐3个最佳搭配产品。

【源商品】
${summarize(product)}
价格: ¥${product.price}

【候选商品】
${others.map((p, i) => `${i + 1}. ID:${p.productId} | ${summarize(p)} | ¥${p.price}`).join('\n')}

【核心规则 - 必须严格遵守】
1. 性别必须一致：[男士]商品只能推荐[男士]或中性商品，[女士]商品只能推荐[女士]或中性商品
2. 禁止推荐同类：服装不推荐服装！上衣不推荐上衣，裤子不推荐裤子，裙子不推荐裙子
3. 优先推荐配饰：耳环、项链、包包、帽子、袜子、鞋子等配饰是最佳选择
4. 同时使用原则：推荐能与源商品一起穿戴的商品，而非替代品

请返回JSON，包含3个推荐:
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
      // Fallback: 优先推荐配饰类商品
      const accessories = others.filter(p =>
        (p.productType || '').toLowerCase().includes('accessor') ||
        (p.productType || '').toLowerCase().includes('footwear')
      );
      const fallbackPool = accessories.length > 0 ? accessories : others;
      fallbackPool.slice(0, 3).forEach(t => {
        results.push({
          sourceId: product.productId,
          targetId: t.productId,
          reason: '完美搭配|Perfect match'
        });
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

// Helper: Check refresh rate limit
function canRefresh(shop) {
  if (!shop.lastRefreshAt) return { allowed: true };

  const lastRefresh = new Date(shop.lastRefreshAt);
  const now = new Date();
  const daysSinceRefresh = (now - lastRefresh) / (1000 * 60 * 60 * 24);

  const plan = shop.plan || 'free';
  const limitDays = plan === 'pro' ? 7 : 30; // Pro: 7 days, Free: 30 days

  if (daysSinceRefresh < limitDays) {
    const nextRefreshDate = new Date(lastRefresh.getTime() + limitDays * 24 * 60 * 60 * 1000);
    return {
      allowed: false,
      nextRefreshAt: nextRefreshDate.toISOString(),
      daysRemaining: Math.ceil(limitDays - daysSinceRefresh)
    };
  }
  return { allowed: true };
}

app.post('/api/products/sync', syncLimiter, auth, async (req, res) => {
  const client = await pool.connect();
  try {
    // mode: 'auto' (default), 'refresh' (force regenerate all)
    const { products, regenerate, mode = 'auto' } = req.body;
    if (!Array.isArray(products) || !products.length) return res.status(400).json({ error: 'Products required' });

    const shopId = req.shop.id;
    const shop = req.shop;
    const isFirstSync = !shop.initialSyncDone;

    // Check refresh rate limit for manual refresh
    if (mode === 'refresh' || regenerate) {
      const refreshCheck = canRefresh(shop);
      if (!refreshCheck.allowed) {
        return res.status(429).json({
          error: 'Refresh rate limit exceeded',
          nextRefreshAt: refreshCheck.nextRefreshAt,
          daysRemaining: refreshCheck.daysRemaining,
          plan: shop.plan || 'free'
        });
      }
    }

    // Determine actual mode
    let actualMode = mode;
    if (isFirstSync) {
      actualMode = 'initial';
    } else if (mode === 'refresh' || regenerate) {
      actualMode = 'refresh';
    } else {
      actualMode = 'incremental';
    }

    console.log(`[Sync] ${shop.domain}: ${products.length} products, mode=${actualMode}, isFirstSync=${isFirstSync}`);

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
      `, [id, shopId, productId, p.handle, p.title, p.description || null, p.productType || null, p.vendor || null, parseFloat(p.price) || 0, (typeof p.image === 'string' ? p.image : p.image?.url) || null, p.tags || []]);

      const result = await client.query('SELECT * FROM "Product" WHERE "shopId" = $1 AND "productId" = $2', [shopId, productId]);
      saved.push(result.rows[0]);
    }

    // Determine which products need recommendations based on mode
    let productsNeedingRecs = saved;
    if (actualMode === 'refresh') {
      // Refresh mode: delete all and regenerate
      await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
      console.log(`[Sync] Refresh mode: Regenerating all recommendations...`);
    } else if (actualMode === 'incremental') {
      // Incremental mode: only new products
      const existingRecs = await client.query(
        'SELECT DISTINCT "sourceId" FROM "Recommendation" WHERE "shopId" = $1',
        [shopId]
      );
      const existingSourceIds = new Set(existingRecs.rows.map(r => r.sourceId));
      productsNeedingRecs = saved.filter(p => !existingSourceIds.has(p.id));
      console.log(`[Sync] Incremental mode: ${productsNeedingRecs.length} new products need recommendations`);
    } else {
      // Initial mode: generate for all
      console.log(`[Sync] Initial mode: Generating recommendations for all ${saved.length} products...`);
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

    // Update shop sync tracking
    const updateFields = {
      productCount: saved.length,
      updatedAt: new Date()
    };

    if (actualMode === 'initial') {
      updateFields.initialSyncDone = true;
      updateFields.lastRefreshAt = new Date();
    } else if (actualMode === 'refresh') {
      updateFields.lastRefreshAt = new Date();
    }

    await client.query(`
      UPDATE "Shop" SET
        "productCount" = $1,
        "updatedAt" = $2,
        "initialSyncDone" = COALESCE($3, "initialSyncDone"),
        "lastRefreshAt" = COALESCE($4, "lastRefreshAt")
      WHERE "id" = $5
    `, [
      updateFields.productCount,
      updateFields.updatedAt,
      updateFields.initialSyncDone || null,
      updateFields.lastRefreshAt || null,
      shopId
    ]);

    console.log(`[Sync] Done: ${saved.length} products, ${count} new recommendations, ${totalRecs.rows[0].count} total, mode=${actualMode}`);
    cache.clear();

    // Calculate next refresh time
    const refreshCheck = canRefresh({ ...shop, lastRefreshAt: updateFields.lastRefreshAt || shop.lastRefreshAt });

    res.json({
      success: true,
      mode: actualMode,
      products: saved.length,
      newRecommendations: count,
      totalRecommendations: parseInt(totalRecs.rows[0].count),
      nextRefreshAt: refreshCheck.nextRefreshAt,
      canRefresh: refreshCheck.allowed
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

    const shopData = shopResult.rows[0];
    const shopId = shopData.id;

    // API 限额检查
    const today = new Date().toISOString().split('T')[0];
    const plan = shopData.plan || 'free';
    const apiLimit = API_LIMITS[plan] || API_LIMITS.free;
    let currentCalls = shopData.apiCallsToday || 0;
    const lastDate = shopData.apiCallsDate ? new Date(shopData.apiCallsDate).toISOString().split('T')[0] : null;

    if (lastDate !== today) {
      currentCalls = 0;
    }

    if (currentCalls >= apiLimit) {
      res.header('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
      res.set('X-RateLimit-Limit', apiLimit);
      res.set('X-RateLimit-Remaining', 0);
      return res.status(429).json({
        error: 'API rate limit exceeded',
        limit: apiLimit,
        used: currentCalls,
        plan
      });
    }

    // 更新 API 调用计数（异步）
    pool.query(`
      UPDATE "Shop" SET
        "apiCallsToday" = CASE WHEN "apiCallsDate" = $1::date THEN "apiCallsToday" + 1 ELSE 1 END,
        "apiCallsDate" = $1::date
      WHERE "id" = $2
    `, [today, shopId]).catch(e => console.error('[API Usage] Error:', e.message));

    // 添加限额响应头
    res.header('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    res.set('X-RateLimit-Limit', apiLimit);
    res.set('X-RateLimit-Remaining', Math.max(0, apiLimit - currentCalls - 1));

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

// 获取商店同步状态
app.get('/api/shops/sync-status', auth, async (req, res) => {
  try {
    const shop = req.shop;
    const refreshStatus = canRefresh(shop);

    // Get product and recommendation counts
    const productCount = await pool.query(
      'SELECT COUNT(*) FROM "Product" WHERE "shopId" = $1',
      [shop.id]
    );
    const recCount = await pool.query(
      'SELECT COUNT(*) FROM "Recommendation" WHERE "shopId" = $1',
      [shop.id]
    );

    // Calculate API usage
    const today = new Date().toISOString().split('T')[0];
    const plan = shop.plan || 'free';
    const apiLimit = API_LIMITS[plan] || API_LIMITS.free;
    let apiCallsToday = shop.apiCallsToday || 0;
    const lastDate = shop.apiCallsDate ? new Date(shop.apiCallsDate).toISOString().split('T')[0] : null;

    if (lastDate !== today) {
      apiCallsToday = 0; // Reset for new day
    }

    res.json({
      success: true,
      syncStatus: {
        initialSyncDone: shop.initialSyncDone || false,
        lastRefreshAt: shop.lastRefreshAt,
        productCount: parseInt(productCount.rows[0].count),
        recommendationCount: parseInt(recCount.rows[0].count),
        plan: shop.plan || 'free',
        canRefresh: refreshStatus.allowed,
        nextRefreshAt: refreshStatus.nextRefreshAt,
        daysUntilRefresh: refreshStatus.daysRemaining,
        // API usage
        apiUsage: {
          used: apiCallsToday,
          limit: apiLimit,
          remaining: Math.max(0, apiLimit - apiCallsToday),
          percentage: Math.min(100, Math.round((apiCallsToday / apiLimit) * 100)),
          resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
        }
      }
    });
  } catch (e) {
    console.error('[SyncStatus] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

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

app.get('/api/recommendations/:productId', queryLimiter, auth, trackApiUsage, async (req, res) => {
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

// Public recommendations endpoint (for storefront without App Proxy)
// This endpoint looks up the shop by domain and returns recommendations
app.get('/api/public/recommendations/:shop/:productId', queryLimiter, async (req, res) => {
  // CORS headers for storefront access
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const { shop: shopDomain, productId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 3, 10);

    // Clean the domain
    const cleanDomain = shopDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log('[Public Recommendations] Request:', { shop: cleanDomain, productId, limit });

    // Find shop by domain
    const shopResult = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (shopResult.rows.length === 0) {
      console.log('[Public Recommendations] Shop not found:', cleanDomain);
      return res.status(404).json({ error: 'Shop not found', productId, recommendations: [] });
    }

    const shop = shopResult.rows[0];
    const shopId = shop.id;

    // Check API usage (but don't block, just track)
    const today = new Date().toISOString().split('T')[0];
    const plan = shop.plan || 'free';
    const apiLimit = API_LIMITS[plan] || API_LIMITS.free;
    let currentCalls = shop.apiCallsToday || 0;
    const lastDate = shop.apiCallsDate ? new Date(shop.apiCallsDate).toISOString().split('T')[0] : null;
    if (lastDate !== today) currentCalls = 0;

    if (currentCalls >= apiLimit) {
      console.log('[Public Recommendations] Rate limit exceeded for shop:', cleanDomain);
      return res.status(429).json({
        error: 'API rate limit exceeded',
        productId,
        recommendations: []
      });
    }

    // Update API usage
    pool.query(`
      UPDATE "Shop" SET
        "apiCallsToday" = CASE WHEN "apiCallsDate" = $1::date THEN "apiCallsToday" + 1 ELSE 1 END,
        "apiCallsDate" = $1::date
      WHERE "id" = $2
    `, [today, shopId]).catch(e => console.error('[Public Recommendations] Update error:', e.message));

    // Cache check
    const cacheKey = `public:${shopId}:${productId}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      console.log('[Public Recommendations] Cache hit');
      return res.json(cached.data);
    }

    // Find source product
    const srcRes = await pool.query(
      'SELECT * FROM "Product" WHERE "shopId" = $1 AND ("productId" = $2 OR "handle" = $2)',
      [shopId, productId]
    );
    if (!srcRes.rows.length) {
      console.log('[Public Recommendations] Product not found:', productId);
      return res.json({ productId, recommendations: [] });
    }

    // Get recommendations
    const recs = await pool.query(`
      SELECT r.*, p."productId", p."handle", p."title", p."price", p."image"
      FROM "Recommendation" r
      JOIN "Product" p ON r."targetId" = p."id"
      WHERE r."shopId" = $1 AND r."sourceId" = $2
      LIMIT $3
    `, [shopId, srcRes.rows[0].id, limit]);

    const data = {
      success: true,
      productId,
      shop: cleanDomain,
      count: recs.rows.length,
      recommendations: recs.rows.map(r => ({
        id: `gid://shopify/Product/${r.productId}`,
        numericId: r.productId,
        handle: r.handle,
        title: r.title,
        price: r.price,
        image: r.image,
        reasoning: r.reason
      }))
    };

    cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL });
    console.log('[Public Recommendations] Returning', recs.rows.length, 'recommendations');
    res.json(data);
  } catch (e) {
    console.error('[Public Recommendations] Error:', e);
    res.status(500).json({ error: e.message, recommendations: [] });
  }
});

// OPTIONS handler for public recommendations
app.options('/api/public/recommendations/:shop/:productId', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

// ============ Shop Plan Management ============

// Get shop plan info
app.get('/api/shops/:domain/plan', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const result = await pool.query(
      'SELECT "plan", "shopifySubscriptionId", "billingStatus", "initialSyncDone", "lastRefreshAt", "productCount" FROM "Shop" WHERE "domain" = $1',
      [domain]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    const refreshStatus = canRefresh(shop);

    res.json({
      plan: shop.plan || 'free',
      shopifySubscriptionId: shop.shopifySubscriptionId,
      billingStatus: shop.billingStatus || 'active',
      initialSyncDone: shop.initialSyncDone || false,
      lastRefreshAt: shop.lastRefreshAt,
      productCount: shop.productCount || 0,
      canRefresh: refreshStatus.allowed,
      nextRefreshAt: refreshStatus.nextRefreshAt
    });
  } catch (e) {
    console.error('[Plan] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update shop plan (for testing/admin)
app.put('/api/shops/:domain/plan', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const { plan, shopifySubscriptionId, billingStatus, lastRefreshAt } = req.body;

    // Build dynamic update query
    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (plan !== undefined) {
      updates.push(`"plan" = $${paramIndex++}`);
      values.push(plan);
    }
    if (shopifySubscriptionId !== undefined) {
      updates.push(`"shopifySubscriptionId" = $${paramIndex++}`);
      values.push(shopifySubscriptionId);
    }
    if (billingStatus !== undefined) {
      updates.push(`"billingStatus" = $${paramIndex++}`);
      values.push(billingStatus);
    }
    if (lastRefreshAt !== undefined) {
      updates.push(`"lastRefreshAt" = $${paramIndex++}`);
      values.push(lastRefreshAt);
    }
    if (req.body.apiCallsToday !== undefined) {
      updates.push(`"apiCallsToday" = $${paramIndex++}`);
      values.push(req.body.apiCallsToday);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`"updatedAt" = NOW()`);
    values.push(domain);

    const query = `UPDATE "Shop" SET ${updates.join(', ')} WHERE "domain" = $${paramIndex} RETURNING *`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    console.log(`[Plan] Updated ${domain}: ${JSON.stringify(req.body)}`);
    res.json({
      success: true,
      ...result.rows[0]
    });
  } catch (e) {
    console.error('[Plan] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ Tracking API ============

// Record impression (when recommendation is shown)
app.post('/api/tracking/impression', async (req, res) => {
  // CORS 头
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Shop-Domain');

  try {
    const { shop, sourceProductId, targetProductIds } = req.body;
    console.log('[Tracking] Impression request:', { shop, sourceProductId, targetProductIds });

    if (!shop || !sourceProductId || !targetProductIds) {
      return res.status(400).json({ error: 'Missing required fields: shop, sourceProductId, targetProductIds' });
    }

    const cleanDomain = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopResult = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (shopResult.rows.length === 0) {
      console.log('[Tracking] Shop not found:', cleanDomain);
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shopId = shopResult.rows[0].id;

    // Find source product (strip gid prefix if present)
    const cleanSourceId = String(sourceProductId).replace('gid://shopify/Product/', '');
    const srcRes = await pool.query(
      'SELECT * FROM "Product" WHERE "shopId" = $1 AND "productId" = $2',
      [shopId, cleanSourceId]
    );
    console.log('[Tracking] Source product lookup:', { cleanSourceId, found: srcRes.rows.length });

    if (!srcRes.rows.length) {
      return res.status(404).json({ error: 'Source product not found', sourceProductId: cleanSourceId });
    }

    const sourceId = srcRes.rows[0].id;
    const targetIds = Array.isArray(targetProductIds) ? targetProductIds : [targetProductIds];

    // Update impression counts for each recommendation
    let updated = 0;
    for (const targetProductId of targetIds) {
      const cleanTargetId = String(targetProductId).replace('gid://shopify/Product/', '');
      const result = await pool.query(`
        UPDATE "Recommendation" r
        SET "impressions" = COALESCE("impressions", 0) + 1
        FROM "Product" p
        WHERE r."shopId" = $1 AND r."sourceId" = $2 AND r."targetId" = p."id" AND p."productId" = $3
      `, [shopId, sourceId, cleanTargetId]);
      updated += result.rowCount;
    }

    console.log('[Tracking] Impressions updated:', { updated });
    res.json({ success: true, updated });
  } catch (e) {
    console.error('[Tracking] Impression error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Record click (when recommendation is clicked)
app.post('/api/tracking/click', async (req, res) => {
  // CORS 头
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Shop-Domain');

  try {
    const { shop, sourceProductId, targetProductId } = req.body;
    console.log('[Tracking] Click request:', { shop, sourceProductId, targetProductId });

    if (!shop || !sourceProductId || !targetProductId) {
      return res.status(400).json({ error: 'Missing required fields: shop, sourceProductId, targetProductId' });
    }

    const cleanDomain = shop.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const shopResult = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (shopResult.rows.length === 0) {
      console.log('[Tracking] Shop not found:', cleanDomain);
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shopId = shopResult.rows[0].id;

    // Find source product (try both with and without prefix stripping)
    const cleanSourceId = String(sourceProductId).replace('gid://shopify/Product/', '');
    const srcRes = await pool.query(
      'SELECT * FROM "Product" WHERE "shopId" = $1 AND "productId" = $2',
      [shopId, cleanSourceId]
    );
    console.log('[Tracking] Source product lookup:', { cleanSourceId, found: srcRes.rows.length });

    if (!srcRes.rows.length) {
      return res.status(404).json({ error: 'Source product not found', sourceProductId: cleanSourceId });
    }

    const sourceId = srcRes.rows[0].id;

    // Find target product
    const cleanTargetId = String(targetProductId).replace('gid://shopify/Product/', '');
    console.log('[Tracking] Looking for target:', { cleanTargetId });

    // Update click count
    const result = await pool.query(`
      UPDATE "Recommendation" r
      SET "clicks" = COALESCE("clicks", 0) + 1
      FROM "Product" p
      WHERE r."shopId" = $1 AND r."sourceId" = $2 AND r."targetId" = p."id" AND p."productId" = $3
    `, [shopId, sourceId, cleanTargetId]);

    console.log('[Tracking] Click updated:', { rowCount: result.rowCount });
    res.json({ success: true, updated: result.rowCount });
  } catch (e) {
    console.error('[Tracking] Click error:', e);
    res.status(500).json({ error: e.message });
  }
});

// OPTIONS handler for CORS preflight
app.options('/api/tracking/impression', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Shop-Domain');
  res.sendStatus(204);
});

app.options('/api/tracking/click', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Shop-Domain');
  res.sendStatus(204);
});

// Get statistics
app.get('/api/statistics', auth, async (req, res) => {
  try {
    const shopId = req.shop.id;

    // Total impressions and clicks
    const totals = await pool.query(`
      SELECT
        COALESCE(SUM("impressions"), 0) as "totalImpressions",
        COALESCE(SUM("clicks"), 0) as "totalClicks"
      FROM "Recommendation"
      WHERE "shopId" = $1
    `, [shopId]);

    const totalImpressions = parseInt(totals.rows[0].totalImpressions);
    const totalClicks = parseInt(totals.rows[0].totalClicks);
    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : 0;

    // Top performing recommendations (by CTR, min 10 impressions)
    const topByCtR = await pool.query(`
      SELECT
        sp."productId" as "sourceProductId",
        sp."title" as "sourceTitle",
        tp."productId" as "targetProductId",
        tp."title" as "targetTitle",
        r."impressions",
        r."clicks",
        CASE WHEN r."impressions" > 0 THEN ROUND((r."clicks"::float / r."impressions" * 100)::numeric, 2) ELSE 0 END as "ctr"
      FROM "Recommendation" r
      JOIN "Product" sp ON r."sourceId" = sp."id"
      JOIN "Product" tp ON r."targetId" = tp."id"
      WHERE r."shopId" = $1 AND r."impressions" >= 10
      ORDER BY "ctr" DESC, r."clicks" DESC
      LIMIT 10
    `, [shopId]);

    // Top by clicks
    const topByClicks = await pool.query(`
      SELECT
        sp."productId" as "sourceProductId",
        sp."title" as "sourceTitle",
        tp."productId" as "targetProductId",
        tp."title" as "targetTitle",
        r."impressions",
        r."clicks",
        CASE WHEN r."impressions" > 0 THEN ROUND((r."clicks"::float / r."impressions" * 100)::numeric, 2) ELSE 0 END as "ctr"
      FROM "Recommendation" r
      JOIN "Product" sp ON r."sourceId" = sp."id"
      JOIN "Product" tp ON r."targetId" = tp."id"
      WHERE r."shopId" = $1 AND r."clicks" > 0
      ORDER BY r."clicks" DESC
      LIMIT 10
    `, [shopId]);

    // Products with most impressions (source products)
    const topSourceProducts = await pool.query(`
      SELECT
        sp."productId",
        sp."title",
        sp."image",
        SUM(r."impressions") as "impressions",
        SUM(r."clicks") as "clicks",
        CASE WHEN SUM(r."impressions") > 0 THEN ROUND((SUM(r."clicks")::float / SUM(r."impressions") * 100)::numeric, 2) ELSE 0 END as "ctr"
      FROM "Recommendation" r
      JOIN "Product" sp ON r."sourceId" = sp."id"
      WHERE r."shopId" = $1
      GROUP BY sp."id", sp."productId", sp."title", sp."image"
      HAVING SUM(r."impressions") > 0
      ORDER BY "impressions" DESC
      LIMIT 10
    `, [shopId]);

    res.json({
      success: true,
      statistics: {
        summary: {
          totalImpressions,
          totalClicks,
          ctr: parseFloat(ctr)
        },
        topByCtr: topByCtR.rows,
        topByClicks: topByClicks.rows,
        topSourceProducts: topSourceProducts.rows.map(r => ({
          ...r,
          impressions: parseInt(r.impressions),
          clicks: parseInt(r.clicks),
          ctr: parseFloat(r.ctr)
        }))
      }
    });
  } catch (e) {
    console.error('[Statistics] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Cancel subscription
app.post('/api/shops/:domain/cancel-subscription', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    const result = await pool.query(`
      UPDATE "Shop" SET
        "plan" = 'free',
        "shopifySubscriptionId" = NULL,
        "billingStatus" = 'cancelled',
        "updatedAt" = NOW()
      WHERE "domain" = $1
      RETURNING *
    `, [domain]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    console.log(`[Plan] Cancelled subscription for ${domain}`);
    res.json({ success: true, plan: 'free' });
  } catch (e) {
    console.error('[Plan] Error:', e);
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
