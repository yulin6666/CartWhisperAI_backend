const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 100, // 最大连接数（使用数据库的全部100个连接）
  idleTimeoutMillis: 10000, // 空闲连接10秒后释放（加快释放）
  connectionTimeoutMillis: 5000, // 连接超时时间
  allowExitOnIdle: false, // 保持进程运行
});
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
    // Monthly refresh tracking
    await addColumn('Shop', 'refreshCount', 'INTEGER', '0');
    await addColumn('Shop', 'refreshMonth', 'TEXT', null);
    // Development store detection
    await addColumn('Shop', 'planName', 'TEXT', null);
    await addColumn('Shop', 'isDevelopmentStore', 'BOOLEAN', 'false');
    await addColumn('Shop', 'isWhitelisted', 'BOOLEAN', 'false');
    // Daily token quota tracking
    await addColumn('Shop', 'dailyTokenQuota', 'INTEGER', '10000000');
    await addColumn('Shop', 'tokensUsedToday', 'INTEGER', '0');
    await addColumn('Shop', 'quotaResetDate', 'DATE', null);
    // Sync permission control
    await addColumn('Shop', 'isSyncEnabled', 'BOOLEAN', 'true');
    await addColumn('Shop', 'globalTokenQuota', 'INTEGER', '140000000');

    // Recommendation tracking (impressions/clicks)
    await addColumn('Recommendation', 'impressions', 'INTEGER', '0');
    await addColumn('Recommendation', 'clicks', 'INTEGER', '0');

    await client.query(`CREATE INDEX IF NOT EXISTS "Shop_plan_idx" ON "Shop"("plan")`);

    // ============ 监控表 ============
    // SyncLog - 记录每次同步操作
    await client.query(`
      CREATE TABLE IF NOT EXISTS "SyncLog" (
        "id" TEXT PRIMARY KEY,
        "shopId" TEXT NOT NULL REFERENCES "Shop"("id") ON DELETE CASCADE,
        "mode" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "startedAt" TIMESTAMP DEFAULT NOW(),
        "completedAt" TIMESTAMP,
        "durationMs" INTEGER,
        "productsScanned" INTEGER DEFAULT 0,
        "productsSynced" INTEGER DEFAULT 0,
        "recommendationsGenerated" INTEGER DEFAULT 0,
        "tokensUsed" INTEGER DEFAULT 0,
        "estimatedCost" FLOAT DEFAULT 0,
        "errorMessage" TEXT,
        "errorStack" TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "SyncLog_shopId_idx" ON "SyncLog"("shopId", "startedAt")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "SyncLog_status_idx" ON "SyncLog"("status")`);

    // ApiLog - 记录API调用（可选，用于详细追踪）
    await client.query(`
      CREATE TABLE IF NOT EXISTS "ApiLog" (
        "id" TEXT PRIMARY KEY,
        "shopId" TEXT REFERENCES "Shop"("id") ON DELETE CASCADE,
        "endpoint" TEXT NOT NULL,
        "method" TEXT NOT NULL,
        "startedAt" TIMESTAMP DEFAULT NOW(),
        "durationMs" INTEGER NOT NULL,
        "statusCode" INTEGER NOT NULL,
        "success" BOOLEAN NOT NULL,
        "tokensUsed" INTEGER DEFAULT 0
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS "ApiLog_shopId_idx" ON "ApiLog"("shopId", "startedAt")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "ApiLog_endpoint_idx" ON "ApiLog"("endpoint")`);

    // ============ 全局配额表 ============
    // GlobalQuota - 存储全局免费配额信息
    await client.query(`
      CREATE TABLE IF NOT EXISTS "GlobalQuota" (
        "id" TEXT PRIMARY KEY DEFAULT 'global',
        "dailyTokenQuota" INTEGER DEFAULT 10000000,
        "tokensUsedToday" INTEGER DEFAULT 0,
        "quotaResetDate" DATE,
        "updatedAt" TIMESTAMP DEFAULT NOW()
      )
    `);

    // 初始化全局配额记录（如果不存在）
    await client.query(`
      INSERT INTO "GlobalQuota" ("id", "dailyTokenQuota", "tokensUsedToday", "quotaResetDate", "updatedAt")
      VALUES ('global', 10000000, 0, CURRENT_DATE, NOW())
      ON CONFLICT ("id") DO NOTHING
    `);

    console.log('[DB] Ready (with monitoring tables and global quota)');
  } finally {
    client.release();
  }
}

// ============ 监控工具类 ============
class SyncMonitor {
  constructor(shopId, mode) {
    this.shopId = shopId;
    this.mode = mode;
    this.logId = `synclog_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    this.startTime = Date.now();
    this.metrics = {
      productsScanned: 0,
      productsSynced: 0,
      recommendationsGenerated: 0,
      tokensUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  async start() {
    try {
      await pool.query(
        `INSERT INTO "SyncLog" ("id", "shopId", "mode", "status", "startedAt") VALUES ($1, $2, $3, $4, NOW())`,
        [this.logId, this.shopId, this.mode, 'started']
      );
      console.log(`[Monitor] Sync started: ${this.logId}`);
      return this.logId;
    } catch (error) {
      console.error('[Monitor] Failed to start:', error);
    }
  }

  updateMetrics(updates) {
    Object.assign(this.metrics, updates);
  }

  recordTokenUsage(usage) {
    // 接受 usage 对象，包含 prompt_tokens 和 completion_tokens
    if (typeof usage === 'number') {
      // 兼容旧的调用方式（只传总数）
      this.metrics.tokensUsed += usage || 0;
    } else if (usage && typeof usage === 'object') {
      // 新的调用方式（传 usage 对象）
      this.metrics.promptTokens += usage.prompt_tokens || 0;
      this.metrics.completionTokens += usage.completion_tokens || 0;
      this.metrics.tokensUsed += usage.total_tokens || 0;
    }
  }

  calculateCost(usage) {
    // DeepSeek 定价（人民币）:
    // - Input tokens (cache miss): 2元/百万tokens
    // - Input tokens (cache hit): 0.2元/百万tokens (暂不考虑缓存)
    // - Output tokens: 3元/百万tokens

    let promptTokens = 0;
    let completionTokens = 0;

    if (typeof usage === 'number') {
      // 兼容旧的调用方式（只传总数），假设 60% input, 40% output
      promptTokens = usage * 0.6;
      completionTokens = usage * 0.4;
    } else if (usage && typeof usage === 'object') {
      // 新的调用方式（传 usage 对象）
      promptTokens = usage.prompt_tokens || 0;
      completionTokens = usage.completion_tokens || 0;
    }

    const inputCostPerMillion = 2;    // 2元/百万tokens
    const outputCostPerMillion = 3;   // 3元/百万tokens

    const inputCost = (promptTokens / 1_000_000) * inputCostPerMillion;
    const outputCost = (completionTokens / 1_000_000) * outputCostPerMillion;

    return inputCost + outputCost;
  }

  async success() {
    const durationMs = Date.now() - this.startTime;
    const estimatedCost = this.calculateCost({
      prompt_tokens: this.metrics.promptTokens,
      completion_tokens: this.metrics.completionTokens,
      total_tokens: this.metrics.tokensUsed
    });

    try {
      await pool.query(
        `UPDATE "SyncLog" SET
          "status" = $1,
          "completedAt" = NOW(),
          "durationMs" = $2,
          "productsScanned" = $3,
          "productsSynced" = $4,
          "recommendationsGenerated" = $5,
          "tokensUsed" = $6,
          "estimatedCost" = $7
        WHERE "id" = $8`,
        ['success', durationMs, this.metrics.productsScanned, this.metrics.productsSynced,
         this.metrics.recommendationsGenerated, this.metrics.tokensUsed, estimatedCost, this.logId]
      );
      console.log(`[Monitor] Sync completed: ${this.logId} (${durationMs}ms, ${this.metrics.tokensUsed} tokens, ¥${estimatedCost.toFixed(4)})`);
    } catch (error) {
      console.error('[Monitor] Failed to update success:', error);
    }
  }

  async fail(error) {
    const durationMs = Date.now() - this.startTime;

    try {
      await pool.query(
        `UPDATE "SyncLog" SET
          "status" = $1,
          "completedAt" = NOW(),
          "durationMs" = $2,
          "productsScanned" = $3,
          "productsSynced" = $4,
          "recommendationsGenerated" = $5,
          "tokensUsed" = $6,
          "errorMessage" = $7,
          "errorStack" = $8
        WHERE "id" = $9`,
        ['failed', durationMs, this.metrics.productsScanned, this.metrics.productsSynced,
         this.metrics.recommendationsGenerated, this.metrics.tokensUsed,
         error.message, error.stack, this.logId]
      );
      console.log(`[Monitor] Sync failed: ${this.logId} - ${error.message}`);
    } catch (err) {
      console.error('[Monitor] Failed to update failure:', err);
    }
  }
}

// API日志记录辅助函数
async function logApiCall(shopId, endpoint, method, durationMs, statusCode, success, tokensUsed = 0) {
  try {
    const logId = `apilog_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await pool.query(
      `INSERT INTO "ApiLog" ("id", "shopId", "endpoint", "method", "startedAt", "durationMs", "statusCode", "success", "tokensUsed")
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7, $8)`,
      [logId, shopId, endpoint, method, durationMs, statusCode, success, tokensUsed]
    );
  } catch (error) {
    console.error('[Monitor] Failed to log API call:', error);
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

// 定期清理过期缓存（每分钟执行一次）
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [key, value] of cache.entries()) {
    if (value.expiry < now) {
      cache.delete(key);
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    console.log(`[Cache] Cleaned ${cleanedCount} expired entries, current size: ${cache.size}`);
  }
}, 60000); // 每60秒清理一次

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

  // 使用原子操作更新计数（同步等待）
  try {
    await pool.query(`
      UPDATE "Shop" SET
        "apiCallsToday" = CASE WHEN "apiCallsDate" = $1::date THEN "apiCallsToday" + 1 ELSE 1 END,
        "apiCallsDate" = $1::date
      WHERE "id" = $2
    `, [today, shop.id]);
  } catch (e) {
    console.error('[API Usage] Update error:', e.message);
    // 即使更新失败，也继续处理请求，避免阻塞用户
  }

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
          { role: 'system', content: 'You are an e-commerce recommendation expert. Return JSON with a recommendations array, each element containing productId and reason. Keep reason brief (under 50 characters). Return only JSON, no other text.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    // 返回完整数据，包括content和usage
    return {
      content: data.choices?.[0]?.message?.content,
      usage: data.usage || null
    };
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
  let totalTokens = 0; // 累加token消耗
  let totalPromptTokens = 0; // 累加输入token
  let totalCompletionTokens = 0; // 累加输出token

  console.log('[AI] ===== GENERATE RECOMMENDATIONS =====');
  console.log(`[AI] Products to generate recs for: ${products.length}`);
  console.log(`[AI] Target pool size: ${targetPool.length}`);
  console.log(`[AI] DeepSeek API Key present: ${!!process.env.DEEPSEEK_API_KEY}`);

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

  // 识别商品细分类型（用于排除同类推荐）
  const getCategory = (p) => {
    const title = (p.title || '').toLowerCase();
    const type = (p.productType || '').toLowerCase();

    // 配饰类（细分）
    if (title.match(/\b(hat|cap|beanie|visor)\b/)) return 'hat';
    if (title.match(/\b(earring|necklace|bracelet|ring|jewelry)\b/)) return 'jewelry';
    if (title.match(/\b(bag|purse|backpack|tote)\b/)) return 'bag';
    if (title.match(/\b(sock|socks)\b/)) return 'sock';
    if (title.match(/\b(shoe|sneaker|boot|sandal|slipper|heel)\b/)) return 'shoe';
    if (title.match(/\b(belt|watch|sunglasses|scarf)\b/)) return 'accessory';

    // 服装类（细分）
    if (title.match(/\b(t-shirt|tee|shirt|top|blouse|tank|cami)\b/) || type.includes('top')) return 'top';
    if (title.match(/\b(pant|jean|trouser|legging|short|jogger)\b/) || type.includes('bottom')) return 'bottom';
    if (title.match(/\b(dress|gown|maxi|mini)\b/) && !title.includes('shirt')) return 'dress';
    if (title.match(/\b(skirt|skort)\b/)) return 'skirt';
    if (title.match(/\b(jacket|coat|blazer|cardigan|hoodie|sweater)\b/)) return 'outerwear';
    if (title.match(/\b(swimsuit|bikini|swim trunk|swimwear)\b/)) return 'swim';
    if (title.match(/\b(bra|panty|underwear|lingerie|bodysuit)\b/)) return 'underwear';
    if (title.match(/\b(pajama|pj|sleep|lounge|robe)\b/)) return 'sleepwear';

    return type || 'other';
  };

  const summarize = (p) => {
    const desc = (p.description || '').substring(0, 100).replace(/\s+/g, ' ');
    const title = p.title || '';
    const type = p.productType || 'Uncategorized';
    const gender = getGender(p);
    const genderLabel = gender === 'male' ? '[Men]' : gender === 'female' ? '[Women]' : '';
    return `${genderLabel}${title} [${type}] ${desc}`;
  };

  for (const product of products) {
    const productGender = getGender(product);
    const productCategory = getCategory(product);

    console.log(`[AI] Processing product: ${product.productId} - "${product.title}" (gender=${productGender}, category=${productCategory})`);

    // 过滤：排除同款、同ID、性别不匹配、同类型的商品
    const others = targetPool.filter(p => {
      if (p.productId === product.productId) return false;
      if (isSameProduct(product, p)) return false;

      // 性别过滤：男士商品不推荐女士商品，女士商品不推荐男士商品
      const targetGender = getGender(p);
      if (productGender === 'male' && targetGender === 'female') return false;
      if (productGender === 'female' && targetGender === 'male') return false;

      // 类型过滤：同类商品不互相推荐（帽子不推荐帽子，上衣不推荐上衣等）
      const targetCategory = getCategory(p);
      if (productCategory === targetCategory && productCategory !== 'other') return false;

      return true;
    });

    console.log(`[AI] After filtering: ${others.length} candidate products for recommendations`);

    if (others.length === 0) {
      console.log(`[AI] ⚠️ No suitable candidates found, skipping this product`);
      continue;
    }

    // 智能选择候选商品：优先配饰，其次按价格排序，限制20个
    const accessories = [];
    const nonAccessories = [];

    // 分类：配饰 vs 非配饰
    others.forEach(p => {
      const category = getCategory(p);
      const isAccessory = ['hat', 'jewelry', 'bag', 'sock', 'shoe', 'accessory'].includes(category);
      if (isAccessory) {
        accessories.push(p);
      } else {
        nonAccessories.push(p);
      }
    });

    // 按价格排序非配饰商品（价格低的优先）
    nonAccessories.sort((a, b) => a.price - b.price);

    // 组合：优先配饰，不够则补充低价商品
    const limitedOthers = [...accessories, ...nonAccessories].slice(0, 20);

    console.log(`[AI] Selected ${limitedOthers.length} candidates (${accessories.length} accessories + ${Math.min(nonAccessories.length, 20 - accessories.length)} low-price items) from ${others.length} total`);

    const prompt = `You are an e-commerce cross-sell recommendation expert. Please recommend 3 best matching products for the following item.

[Source Product]
${summarize(product)}
Price: $${product.price}

[Candidate Products]
${limitedOthers.map((p, i) => `${i + 1}. ID:${p.productId} | ${summarize(p)} | $${p.price}`).join('\n')}

[Core Rules - Must Follow Strictly]
1. Gender must match: [Men] products can only recommend [Men] or unisex items, [Women] products can only recommend [Women] or unisex items
2. No same-category recommendations: Don't recommend clothing for clothing! No tops for tops, no pants for pants, no dresses for dresses
3. Prioritize accessories: Earrings, necklaces, bags, hats, socks, shoes and other accessories are the best choices
4. Complementary principle: Recommend items that can be worn together with the source product, not replacements

Return JSON with 3 recommendations in ENGLISH ONLY:
{"recommendations":[{"productId":"xxx","reason":"English reason only"}]}`;

    console.log(`[AI] Calling DeepSeek API for product ${product.productId}...`);
    const aiRes = await callDeepSeek(prompt);

    if (aiRes) {
      console.log(`[AI] ✅ DeepSeek API response received`);
      // 累加token消耗（分别记录输入和输出token）
      if (aiRes.usage) {
        if (aiRes.usage.total_tokens) {
          totalTokens += aiRes.usage.total_tokens;
        }
        if (aiRes.usage.prompt_tokens) {
          totalPromptTokens += aiRes.usage.prompt_tokens;
        }
        if (aiRes.usage.completion_tokens) {
          totalCompletionTokens += aiRes.usage.completion_tokens;
        }
        console.log(`[AI] Tokens used: ${aiRes.usage.total_tokens} (input: ${aiRes.usage.prompt_tokens}, output: ${aiRes.usage.completion_tokens})`);
      }

      try {
        const json = aiRes.content?.match(/\{[\s\S]*\}/)?.[0];
        if (json) {
          const parsed = JSON.parse(json);
          const seen = new Set(); // 避免重复推荐
          let addedForThisProduct = 0;
          for (const rec of (parsed.recommendations || []).slice(0, 3)) {
            const productId = String(rec.productId);
            if (seen.has(productId)) continue;

            const target = others.find(p => p.productId === productId);
            if (target) {
              seen.add(productId);
              results.push({
                sourceId: product.productId,
                targetId: target.productId,
                reason: rec.reason || 'Recommended pairing'
              });
              addedForThisProduct++;
            }
          }
          console.log(`[AI] ✅ Added ${addedForThisProduct} recommendations for product ${product.productId}`);
        } else {
          console.warn(`[AI] ⚠️ Could not extract JSON from AI response`);
        }
      } catch (e) {
        console.error('[AI] ❌ Parse error:', e.message);
      }
    } else {
      console.log(`[AI] ⚠️ No AI response, using fallback recommendations`);
      // Fallback: 优先推荐配饰类商品
      const accessories = others.filter(p =>
        (p.productType || '').toLowerCase().includes('accessor') ||
        (p.productType || '').toLowerCase().includes('footwear')
      );
      const fallbackPool = accessories.length > 0 ? accessories : others;
      let fallbackCount = 0;
      fallbackPool.slice(0, 3).forEach(t => {
        results.push({
          sourceId: product.productId,
          targetId: t.productId,
          reason: 'Perfect match'
        });
        fallbackCount++;
      });
      console.log(`[AI] Added ${fallbackCount} fallback recommendations for product ${product.productId}`);
    }
    if (process.env.DEEPSEEK_API_KEY) await new Promise(r => setTimeout(r, 200));
  }

  console.log('[AI] ===== GENERATION COMPLETE =====');
  console.log(`[AI] Total recommendations generated: ${results.length}`);
  console.log(`[AI] Total tokens used: ${totalTokens}`);

  return {
    recommendations: results,
    totalTokens,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens
  };
}

// ============ Development Store Detection ============
/**
 * 判断是否为开发店
 * @param {string} planName - Shopify plan name
 * @returns {boolean}
 */
function isDevelopmentStore(planName) {
  if (!planName) return false;

  const planLower = planName.toLowerCase();

  // 开发店的plan关键词
  const devKeywords = [
    'development',  // Basic App Development, Development Store
    'partner',      // Partner Test, Partner Development
    'affiliate',    // Affiliate
    'staff',        // Staff
    'trial',        // Trial
    'frozen',       // Frozen
    'cancelled',    // Cancelled
    'dormant',      // Dormant
    'test'          // Test Store
  ];

  // 正式付费plan（排除这些）
  const paidPlans = [
    'basic',        // Basic (正式付费)
    'shopify',      // Shopify (正式付费)
    'advanced',     // Advanced (正式付费)
    'plus',         // Shopify Plus
    'unlimited',    // Unlimited (旧版)
    'professional'  // Professional (旧版)
  ];

  // 如果包含付费plan关键词但不包含development，则是正式店
  const isPaidPlan = paidPlans.some(paid => planLower.includes(paid)) && !planLower.includes('development');
  if (isPaidPlan) return false;

  // 检查是否包含开发店关键词
  return devKeywords.some(keyword => planLower.includes(keyword));
}

/**
 * 检查开发店是否可以使用服务
 * @param {object} shop - Shop对象
 * @returns {{ allowed: boolean, reason?: string }}
 */
function checkDevelopmentStoreAccess(shop) {
  // 如果在白名单中，允许访问
  if (shop.isWhitelisted) {
    return { allowed: true };
  }

  // 如果是开发店且不在白名单中，拒绝访问
  if (shop.isDevelopmentStore) {
    return {
      allowed: false,
      reason: 'Development stores are not eligible for the free plan. Please upgrade to a paid Shopify plan or contact support for whitelist access.'
    };
  }

  return { allowed: true };
}

/**
 * 检查并重置全局每日Token配额
 * @returns {Promise<{allowed: boolean, tokensRemaining: number, quotaResetDate: string, reason?: string}>}
 */
async function checkDailyTokenQuota() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // 获取全局配额信息
  const result = await pool.query(`SELECT * FROM "GlobalQuota" WHERE "id" = 'global'`);
  const globalQuota = result.rows[0];

  if (!globalQuota) {
    // 如果没有全局配额记录，创建一个
    await pool.query(`
      INSERT INTO "GlobalQuota" ("id", "dailyTokenQuota", "tokensUsedToday", "quotaResetDate", "updatedAt")
      VALUES ('global', 10000000, 0, $1::date, NOW())
    `, [today]);

    return {
      allowed: true,
      tokensRemaining: 10000000,
      quota: 10000000,
      tokensUsed: 0,
      quotaResetDate: today
    };
  }

  const quota = globalQuota.dailyTokenQuota || 10000000; // 默认1000万 tokens/天
  let tokensUsed = globalQuota.tokensUsedToday || 0;
  const lastResetDate = globalQuota.quotaResetDate ? new Date(globalQuota.quotaResetDate).toISOString().split('T')[0] : null;

  // 检查是否需要重置（新的一天）
  if (lastResetDate !== today) {
    console.log(`[TokenQuota] Resetting global daily quota (last reset: ${lastResetDate}, today: ${today})`);
    tokensUsed = 0;
    // 更新数据库
    await pool.query(
      `UPDATE "GlobalQuota" SET "tokensUsedToday" = 0, "quotaResetDate" = $1::date, "updatedAt" = NOW() WHERE "id" = 'global'`,
      [today]
    );
  }

  const tokensRemaining = Math.max(0, quota - tokensUsed);

  // 检查是否超过配额
  if (tokensUsed >= quota) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    return {
      allowed: false,
      tokensRemaining: 0,
      quota,
      tokensUsed,
      quotaResetDate: tomorrow.toISOString(),
      reason: `Daily token quota exceeded (${tokensUsed}/${quota}). Quota resets at midnight.`
    };
  }

  return {
    allowed: true,
    tokensRemaining,
    quota,
    tokensUsed,
    quotaResetDate: today
  };
}

/**
 * 更新全局Token使用量和商店Token使用量（使用行级锁防止竞态条件）
 * @param {number} tokensUsed - 本次使用的token数
 * @param {string} shopId - 商店ID
 * @param {object} client - 可选的数据库客户端（如果在事务中调用）
 */
async function updateTokenUsage(tokensUsed, shopId, client = null) {
  const today = new Date().toISOString().split('T')[0];
  const ownClient = !client;

  if (ownClient) {
    client = await pool.connect();
  }

  try {
    if (ownClient) {
      await client.query('BEGIN');
    }

    // 使用行级锁更新全局配额
    const globalResult = await client.query(`
      SELECT "tokensUsedToday", "quotaResetDate", "dailyTokenQuota"
      FROM "GlobalQuota"
      WHERE "id" = 'global'
      FOR UPDATE
    `);

    if (globalResult.rows.length > 0) {
      const global = globalResult.rows[0];
      const lastResetDate = global.quotaResetDate ? new Date(global.quotaResetDate).toISOString().split('T')[0] : null;

      let newTokensUsed = tokensUsed;
      if (lastResetDate === today) {
        newTokensUsed = (global.tokensUsedToday || 0) + tokensUsed;
      }

      await client.query(`
        UPDATE "GlobalQuota" SET
          "tokensUsedToday" = $1,
          "quotaResetDate" = $2::date,
          "updatedAt" = NOW()
        WHERE "id" = 'global'
      `, [newTokensUsed, today]);

      // 检查是否超过配额
      if (newTokensUsed > global.dailyTokenQuota) {
        console.warn(`[TokenQuota] WARNING: Global quota exceeded (${newTokensUsed}/${global.dailyTokenQuota})`);
      }
    }

    // 使用行级锁更新商店配额
    if (shopId) {
      const shopResult = await client.query(`
        SELECT "tokensUsedToday", "quotaResetDate"
        FROM "Shop"
        WHERE "id" = $1
        FOR UPDATE
      `, [shopId]);

      if (shopResult.rows.length > 0) {
        const shop = shopResult.rows[0];
        const lastResetDate = shop.quotaResetDate ? new Date(shop.quotaResetDate).toISOString().split('T')[0] : null;

        let newTokensUsed = tokensUsed;
        if (lastResetDate === today) {
          newTokensUsed = (shop.tokensUsedToday || 0) + tokensUsed;
        }

        await client.query(`
          UPDATE "Shop" SET
            "tokensUsedToday" = $1,
            "quotaResetDate" = $2::date,
            "updatedAt" = NOW()
          WHERE "id" = $3
        `, [newTokensUsed, today, shopId]);
      }
    }

    if (ownClient) {
      await client.query('COMMIT');
    }
    console.log(`[TokenQuota] Updated token usage: +${tokensUsed} tokens (shop: ${shopId || 'N/A'})`);
  } catch (error) {
    if (ownClient) {
      await client.query('ROLLBACK');
    }
    console.error('[TokenQuota] Failed to update global token usage:', error);
    throw error;
  } finally {
    if (ownClient) {
      client.release();
    }
  }
}

// ============ Routes ============

// 商店注册 - 自动获取 API Key
app.post('/api/shops/register', async (req, res) => {
  try {
    const { domain, planName } = req.body;
    if (!domain) return res.status(400).json({ error: 'Domain required' });

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // 检查是否已存在
    const existing = await pool.query('SELECT * FROM "Shop" WHERE "domain" = $1', [cleanDomain]);
    if (existing.rows.length > 0) {
      const shop = existing.rows[0];

      // 更新 planName 和 isDevelopmentStore（如果提供了 planName）
      if (planName) {
        const isDevStore = isDevelopmentStore(planName);
        await pool.query(
          `UPDATE "Shop" SET "planName" = $1, "isDevelopmentStore" = $2, "updatedAt" = NOW() WHERE "domain" = $3`,
          [planName, isDevStore, cleanDomain]
        );
        console.log(`[Register] Updated shop ${cleanDomain}: planName=${planName}, isDevelopmentStore=${isDevStore}`);

        // 更新shop对象以便检查
        shop.planName = planName;
        shop.isDevelopmentStore = isDevStore;
      }

      // 检查开发店访问权限
      const accessCheck = checkDevelopmentStoreAccess(shop);
      if (!accessCheck.allowed) {
        return res.status(403).json({
          error: accessCheck.reason,
          isDevelopmentStore: true,
          isWhitelisted: false,
          requiresWhitelist: true
        });
      }

      return res.json({
        success: true,
        apiKey: existing.rows[0].apiKey,
        isNew: false,
        message: 'Shop already registered',
        isDevelopmentStore: shop.isDevelopmentStore || false,
        isWhitelisted: shop.isWhitelisted || false
      });
    }

    // 检测是否为开发店
    const isDevStore = planName ? isDevelopmentStore(planName) : false;

    // 如果是开发店且不在白名单，拒绝注册
    if (isDevStore) {
      return res.status(403).json({
        error: 'Development stores are not eligible for the free plan. Please upgrade to a paid Shopify plan or contact support for whitelist access.',
        isDevelopmentStore: true,
        isWhitelisted: false,
        requiresWhitelist: true
      });
    }

    // 生成新的 API Key
    const apiKey = `cw_${crypto.randomUUID().replace(/-/g, '')}`;
    const shopId = `shop_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

    await pool.query(
      `INSERT INTO "Shop" ("id", "domain", "apiKey", "planName", "isDevelopmentStore", "createdAt") VALUES ($1, $2, $3, $4, $5, NOW())`,
      [shopId, cleanDomain, apiKey, planName || null, isDevStore]
    );

    console.log(`[Register] New shop: ${cleanDomain}, planName=${planName}, isDevelopmentStore=${isDevStore}`);
    res.json({
      success: true,
      apiKey,
      isNew: true,
      message: 'Shop registered successfully',
      isDevelopmentStore: isDevStore,
      isWhitelisted: false
    });
  } catch (e) {
    console.error('[Register] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    // 查询数据库最大连接数
    const maxConnResult = await pool.query('SHOW max_connections');
    const dbMaxConnections = parseInt(maxConnResult.rows[0].max_connections);

    // 获取连接池状态
    const poolStatus = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      maxConnections: pool.options.max || 500,
      activeConnections: pool.totalCount - pool.idleCount,
      utilizationPercentage: pool.totalCount > 0
        ? Math.round(((pool.totalCount - pool.idleCount) / (pool.options.max || 500)) * 100)
        : 0,
      // 数据库服务器信息
      database: {
        maxConnections: dbMaxConnections,
        poolMaxConnections: pool.options.max || 500,
        isPoolSizeValid: (pool.options.max || 500) <= dbMaxConnections,
        recommendation: (pool.options.max || 500) > dbMaxConnections
          ? `警告: 连接池大小(${pool.options.max})超过数据库最大连接数(${dbMaxConnections})，建议调整为 ${Math.floor(dbMaxConnections * 0.8)}`
          : '配置正常'
      }
    };

    res.json({
      status: 'ok',
      ai: !!process.env.DEEPSEEK_API_KEY,
      pool: poolStatus,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Helper: Check refresh rate limit
function canRefresh(shop) {
  const plan = shop.plan || 'free';

  // 月度刷新次数限制
  const REFRESH_LIMITS = {
    free: 1,   // 1次/月（初始同步）
    pro: 3,    // 3次/月（初始同步 + 2次额外）
    max: 10    // 10次/月
  };

  const limit = REFRESH_LIMITS[plan] || REFRESH_LIMITS.free;

  // 使用订阅开始时间计算周期，而不是自然月
  const now = new Date();
  let currentCycle = null;

  if (shop.subscriptionStartedAt) {
    // 基于订阅开始日期计算当前周期
    const startDate = new Date(shop.subscriptionStartedAt);
    const dayOfMonth = startDate.getDate();

    // 计算当前周期的开始日期
    const cycleStart = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
    if (cycleStart > now) {
      // 如果本月的周期开始日期还没到，使用上个月的
      cycleStart.setMonth(cycleStart.getMonth() - 1);
    }

    currentCycle = cycleStart.toISOString().slice(0, 10); // YYYY-MM-DD
  } else {
    // 如果没有订阅开始时间，回退到自然月逻辑
    currentCycle = now.toISOString().slice(0, 7); // YYYY-MM
  }

  // 检查是否是新的周期，重置计数
  let refreshCount = shop.refreshCount || 0;
  const lastCycle = shop.refreshMonth;

  if (lastCycle !== currentCycle) {
    // 新的周期，重置计数
    refreshCount = 0;
  }

  // 检查是否超过限额
  if (refreshCount >= limit) {
    // 计算下次可刷新时间（下个周期开始日期）
    let nextCycleStart;
    if (shop.subscriptionStartedAt) {
      const startDate = new Date(shop.subscriptionStartedAt);
      const dayOfMonth = startDate.getDate();
      nextCycleStart = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
      if (nextCycleStart <= now) {
        nextCycleStart.setMonth(nextCycleStart.getMonth() + 1);
      }
    } else {
      // 回退到自然月逻辑
      nextCycleStart = new Date(currentCycle + '-01');
      nextCycleStart.setMonth(nextCycleStart.getMonth() + 1);
    }

    return {
      allowed: false,
      limit,
      used: refreshCount,
      remaining: 0,
      nextRefreshAt: nextCycleStart.toISOString(),
      plan
    };
  }

  return {
    allowed: true,
    limit,
    used: refreshCount,
    remaining: limit - refreshCount,
    plan
  };
}

app.post('/api/products/sync', syncLimiter, auth, async (req, res) => {
  const client = await pool.connect();

  // 创建监控实例
  const { products, regenerate, mode = 'auto' } = req.body;
  const shopId = req.shop.id;
  const shop = req.shop;
  const isFirstSync = !shop.initialSyncDone;

  console.log('='.repeat(80));
  console.log('[SYNC] ===== NEW SYNC REQUEST =====');
  console.log(`[SYNC] Shop: ${shop.domain} (ID: ${shopId})`);
  console.log(`[SYNC] Request params: mode="${mode}", regenerate=${regenerate}`);
  console.log(`[SYNC] Products received: ${products?.length || 0}`);
  console.log(`[SYNC] Shop state: initialSyncDone=${shop.initialSyncDone}, lastRefreshAt=${shop.lastRefreshAt}`);
  console.log('='.repeat(80));

  // 确定实际模式用于监控
  let monitorMode = mode;
  if (isFirstSync) {
    monitorMode = 'initial';
  } else if (mode === 'refresh' || regenerate) {
    monitorMode = 'refresh';
  } else {
    monitorMode = 'incremental';
  }

  console.log(`[SYNC] Monitor mode determined: ${monitorMode}`);

  const monitor = new SyncMonitor(shopId, monitorMode);
  await monitor.start();

  try {
    // 开始事务
    await client.query('BEGIN');

    // 检查商店是否被禁用同步
    if (shop.isSyncEnabled === false) {
      console.error(`[SYNC] ❌ ERROR: Sync is disabled for shop ${shop.domain}`);
      await monitor.fail(new Error('Sync is disabled for this shop'));
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'Sync is disabled for this shop. Please contact support.',
        code: 'SYNC_DISABLED'
      });
    }

    if (!Array.isArray(products) || !products.length) {
      console.error('[SYNC] ❌ ERROR: No products array received');
      await monitor.fail(new Error('Products required'));
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Products required' });
    }

    console.log(`[SYNC] ✅ Products validation passed: ${products.length} products`);
    monitor.updateMetrics({ productsScanned: products.length });

    // Check development store access
    const accessCheck = checkDevelopmentStoreAccess(shop);
    if (!accessCheck.allowed) {
      console.error(`[SYNC] ❌ Development store access denied: ${shop.domain}`);
      await monitor.fail(new Error('Development store access denied'));
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: accessCheck.reason,
        isDevelopmentStore: true,
        isWhitelisted: false,
        requiresWhitelist: true
      });
    }

    // Check daily token quota (only for free plan)
    const plan = shop.plan || 'free';
    if (plan === 'free') {
      const quotaCheck = await checkDailyTokenQuota();
      if (!quotaCheck.allowed) {
        console.error(`[SYNC] ❌ Daily token quota exceeded: ${shop.domain}`);
        await monitor.fail(new Error('Daily token quota exceeded'));
        await client.query('ROLLBACK');
        return res.status(429).json({
          error: quotaCheck.reason,
          tokenQuotaExceeded: true,
          tokensRemaining: quotaCheck.tokensRemaining,
          quota: quotaCheck.quota,
          tokensUsed: quotaCheck.tokensUsed,
          quotaResetDate: quotaCheck.quotaResetDate
        });
      }
      console.log(`[SYNC] ✅ Token quota check passed: ${quotaCheck.tokensRemaining}/${quotaCheck.quota} tokens remaining`);
    }

    // Check refresh rate limit for manual refresh (使用行级锁)
    if (mode === 'refresh' || regenerate) {
      // 使用行级锁获取最新的刷新计数
      const shopLockResult = await client.query(`
        SELECT "refreshCount", "refreshMonth", "plan"
        FROM "Shop"
        WHERE "id" = $1
        FOR UPDATE
      `, [shopId]);

      if (shopLockResult.rows.length > 0) {
        const lockedShop = shopLockResult.rows[0];
        const currentMonth = new Date().toISOString().slice(0, 7);

        let refreshCount = lockedShop.refreshCount || 0;
        if (lockedShop.refreshMonth !== currentMonth) {
          refreshCount = 0; // 新月份，重置计数
        }

        const plan = lockedShop.plan || 'free';
        const REFRESH_LIMITS = {
          free: 0,   // 0次/月（不允许）
          pro: 3,    // 3次/月
          max: 10    // 10次/月
        };
        const limit = REFRESH_LIMITS[plan] || REFRESH_LIMITS.free;

        if (refreshCount >= limit) {
          // 计算下次可刷新时间（下个月1号）
          const nextMonth = new Date(currentMonth + '-01');
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          await monitor.fail(new Error('Refresh rate limit exceeded'));
          await client.query('ROLLBACK');
          return res.status(429).json({
            error: 'Refresh rate limit exceeded',
            limit,
            used: refreshCount,
            remaining: 0,
            nextRefreshAt: nextMonth.toISOString(),
            plan
          });
        }
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

    console.log('[SYNC] ===== DETERMINING RECOMMENDATION STRATEGY =====');
    console.log(`[SYNC] Actual mode: ${actualMode}`);
    console.log(`[SYNC] Total products saved: ${saved.length}`);

    if (actualMode === 'refresh') {
      // Refresh mode: delete all and regenerate
      console.log('[SYNC] 🔄 REFRESH MODE: Deleting all existing recommendations...');
      const deleteResult = await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
      console.log(`[SYNC] ✅ Deleted ${deleteResult.rowCount} existing recommendations`);
      console.log(`[SYNC] Will regenerate recommendations for ALL ${saved.length} products`);
    } else if (actualMode === 'incremental') {
      // Incremental mode: only new products
      console.log('[SYNC] 📈 INCREMENTAL MODE: Finding products without recommendations...');
      const existingRecs = await client.query(
        'SELECT DISTINCT "sourceId" FROM "Recommendation" WHERE "shopId" = $1',
        [shopId]
      );
      console.log(`[SYNC] Found ${existingRecs.rows.length} products with existing recommendations`);
      const existingSourceIds = new Set(existingRecs.rows.map(r => r.sourceId));
      productsNeedingRecs = saved.filter(p => !existingSourceIds.has(p.id));
      console.log(`[SYNC] ✅ Filtered down to ${productsNeedingRecs.length} NEW products needing recommendations`);
      if (productsNeedingRecs.length > 0) {
        console.log(`[SYNC] Sample products needing recs:`, productsNeedingRecs.slice(0, 3).map(p => ({ id: p.productId, title: p.title })));
      }
    } else {
      // Initial mode: generate for all
      console.log(`[SYNC] 🆕 INITIAL MODE: Generating recommendations for ALL ${saved.length} products`);
    }

    console.log('[SYNC] ===== RECOMMENDATION GENERATION PHASE =====');
    console.log(`[SYNC] Products needing recommendations: ${productsNeedingRecs.length}`);

    let count = 0;
    if (productsNeedingRecs.length > 0) {
      console.log(`[SYNC] 🤖 Calling AI to generate recommendations for ${productsNeedingRecs.length} products...`);
      console.log(`[SYNC] Total product pool for recommendations: ${saved.length}`);

      const { recommendations: recs, totalTokens, promptTokens, completionTokens } = await generateRecommendations(productsNeedingRecs, saved);

      console.log(`[SYNC] ✅ AI returned ${recs.length} recommendations`);
      console.log(`[SYNC] Token usage: total=${totalTokens}, input=${promptTokens}, output=${completionTokens}`);

      // 记录token消耗（传入完整的 usage 对象）
      if (totalTokens > 0) {
        monitor.recordTokenUsage({
          total_tokens: totalTokens,
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens
        });
      }

      console.log(`[SYNC] 💾 Saving ${recs.length} recommendations to database...`);
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
        } else {
          console.warn(`[SYNC] ⚠️ Could not find src or tgt for recommendation:`, { sourceId: rec.sourceId, targetId: rec.targetId, srcFound: !!src, tgtFound: !!tgt });
        }
      }
      console.log(`[SYNC] ✅ Successfully saved ${count} recommendations to database`);
    } else {
      console.log('[SYNC] ⏭️ No products need recommendations, skipping generation phase');
    }

    // 获取总推荐数
    const totalRecs = await client.query('SELECT COUNT(*) FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
    const totalRecsCount = parseInt(totalRecs.rows[0].count);

    console.log('[SYNC] ===== DATABASE STATE AFTER SYNC =====');
    console.log(`[SYNC] Total recommendations in DB: ${totalRecsCount}`);
    console.log(`[SYNC] New recommendations created this sync: ${count}`);

    // Update shop sync tracking
    const updateFields = {
      productCount: saved.length,
      updatedAt: new Date()
    };

    // 计算当前周期（基于订阅开始时间）
    const now = new Date();
    let currentCycle = null;

    if (shop.subscriptionStartedAt) {
      // 基于订阅开始日期计算当前周期
      const startDate = new Date(shop.subscriptionStartedAt);
      const dayOfMonth = startDate.getDate();

      // 计算当前周期的开始日期
      const cycleStart = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
      if (cycleStart > now) {
        // 如果本月的周期开始日期还没到，使用上个月的
        cycleStart.setMonth(cycleStart.getMonth() - 1);
      }

      currentCycle = cycleStart.toISOString().slice(0, 10); // YYYY-MM-DD
    } else {
      // 如果没有订阅开始时间，回退到自然月逻辑
      currentCycle = now.toISOString().slice(0, 7); // YYYY-MM
    }

    if (actualMode === 'initial') {
      updateFields.initialSyncDone = true;
      updateFields.lastRefreshAt = new Date();
      console.log('[SYNC] Setting initialSyncDone = true');
    } else if (actualMode === 'refresh') {
      updateFields.lastRefreshAt = new Date();

      // 使用行级锁重新获取最新的刷新计数（防止竞态条件）
      const shopRefreshResult = await client.query(`
        SELECT "refreshCount", "refreshMonth"
        FROM "Shop"
        WHERE "id" = $1
        FOR UPDATE
      `, [shopId]);

      if (shopRefreshResult.rows.length > 0) {
        const currentShop = shopRefreshResult.rows[0];
        const lastCycle = currentShop.refreshMonth;

        if (lastCycle !== currentCycle) {
          // 新周期，重置为1
          updateFields.refreshCount = 1;
          updateFields.refreshMonth = currentCycle;
        } else {
          // 同一周期，增加计数
          updateFields.refreshCount = (currentShop.refreshCount || 0) + 1;
          updateFields.refreshMonth = currentCycle;
        }
        console.log(`[SYNC] Updating refresh count: ${updateFields.refreshCount} (cycle: ${currentCycle})`);
      }
    }

    await client.query(`
      UPDATE "Shop" SET
        "productCount" = $1,
        "updatedAt" = $2,
        "initialSyncDone" = COALESCE($3, "initialSyncDone"),
        "lastRefreshAt" = COALESCE($4, "lastRefreshAt"),
        "refreshCount" = COALESCE($5, "refreshCount"),
        "refreshMonth" = COALESCE($6, "refreshMonth")
      WHERE "id" = $7
    `, [
      updateFields.productCount,
      updateFields.updatedAt,
      updateFields.initialSyncDone || null,
      updateFields.lastRefreshAt || null,
      updateFields.refreshCount !== undefined ? updateFields.refreshCount : null,
      updateFields.refreshMonth || null,
      shopId
    ]);

    console.log(`[SYNC] ===== SYNC COMPLETE =====`);
    console.log(`[SYNC] Summary:`);
    console.log(`[SYNC]   - Mode: ${actualMode}`);
    console.log(`[SYNC]   - Products synced: ${saved.length}`);
    console.log(`[SYNC]   - New recommendations: ${count}`);
    console.log(`[SYNC]   - Total recommendations: ${totalRecsCount}`);
    console.log('='.repeat(80));

    cache.clear();

    // 更新监控指标
    monitor.updateMetrics({
      productsSynced: saved.length,
      recommendationsGenerated: count
    });
    await monitor.success();

    // 更新Token使用量（仅免费用户）
    if (plan === 'free' && monitor.metrics.tokensUsed > 0) {
      await updateTokenUsage(monitor.metrics.tokensUsed, shopId, client);
      console.log(`[SYNC] 📊 Updated token usage: ${monitor.metrics.tokensUsed} tokens`);
    }

    // Calculate next refresh time with updated shop data
    const updatedShop = {
      ...shop,
      lastRefreshAt: updateFields.lastRefreshAt || shop.lastRefreshAt,
      refreshCount: updateFields.refreshCount !== undefined ? updateFields.refreshCount : shop.refreshCount,
      refreshMonth: updateFields.refreshMonth || shop.refreshMonth
    };
    const refreshCheck = canRefresh(updatedShop);

    // Get updated token quota info
    let tokenQuotaInfo = null;
    if (plan === 'free') {
      const quotaCheck = await checkDailyTokenQuota();
      tokenQuotaInfo = {
        tokensRemaining: quotaCheck.tokensRemaining,
        quota: quotaCheck.quota,
        tokensUsed: quotaCheck.tokensUsed,
        quotaResetDate: quotaCheck.quotaResetDate
      };
    }

    // 提交事务
    console.log('[SYNC] 💾 Committing transaction...');
    await client.query('COMMIT');
    console.log('[SYNC] ✅ Transaction committed successfully');

    // 立即释放数据库连接
    client.release();
    console.log('[SYNC] 🔓 Database connection released');

    const responseData = {
      success: true,
      mode: actualMode,
      products: saved.length,
      newRecommendations: count,
      totalRecommendations: parseInt(totalRecs.rows[0].count),
      refreshLimit: {
        limit: refreshCheck.limit,
        used: refreshCheck.used,
        remaining: refreshCheck.remaining,
        nextRefreshAt: refreshCheck.nextRefreshAt
      },
      canRefresh: refreshCheck.allowed,
      tokenQuota: tokenQuotaInfo
    };

    console.log('[SYNC] 📤 Sending response to client...');
    res.json(responseData);
    console.log('[SYNC] ✅ Response sent successfully');
  } catch (e) {
    // 回滚事务
    await client.query('ROLLBACK');
    console.error('[Sync] Error:', e);
    await monitor.fail(e);

    // 确保连接被释放
    try {
      client.release();
    } catch (releaseError) {
      console.error('[Sync] Error releasing connection:', releaseError);
    }

    res.status(500).json({ error: e.message });
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
    const cacheKey = `sync-status:${shop.id}`;

    // 检查缓存（30秒有效期）
    const cached = cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      console.log(`[SyncStatus] Cache hit for shop ${shop.domain}`);
      return res.json(cached.data);
    }

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

    // Get token quota info (for free plan)
    let tokenQuota = null;
    if (plan === 'free') {
      const quotaCheck = await checkDailyTokenQuota();
      tokenQuota = {
        tokensRemaining: quotaCheck.tokensRemaining,
        quota: quotaCheck.quota,
        tokensUsed: quotaCheck.tokensUsed,
        quotaResetDate: quotaCheck.quotaResetDate
      };
    }

    // Check if there's an ongoing sync (status = 'started')
    const ongoingSyncResult = await pool.query(
      `SELECT "id", "mode", "startedAt"
       FROM "SyncLog"
       WHERE "shopId" = $1 AND "status" = 'started'
       ORDER BY "startedAt" DESC
       LIMIT 1`,
      [shop.id]
    );
    const isSyncing = ongoingSyncResult.rows.length > 0;
    const ongoingSync = isSyncing ? {
      id: ongoingSyncResult.rows[0].id,
      mode: ongoingSyncResult.rows[0].mode,
      startedAt: ongoingSyncResult.rows[0].startedAt
    } : null;

    const responseData = {
      success: true,
      syncStatus: {
        initialSyncDone: shop.initialSyncDone || false,
        lastRefreshAt: shop.lastRefreshAt,
        productCount: parseInt(productCount.rows[0].count),
        recommendationCount: parseInt(recCount.rows[0].count),
        plan: shop.plan || 'free',
        // 同步状态
        isSyncing: isSyncing,
        ongoingSync: ongoingSync,
        // 刷新限制信息
        refreshLimit: {
          limit: refreshStatus.limit,
          used: refreshStatus.used,
          remaining: refreshStatus.remaining,
          canRefresh: refreshStatus.allowed && !isSyncing, // 如果正在同步，不能再次刷新
          nextRefreshAt: refreshStatus.nextRefreshAt
        },
        // API usage
        apiUsage: {
          used: apiCallsToday,
          limit: apiLimit,
          remaining: Math.max(0, apiLimit - apiCallsToday),
          percentage: Math.min(100, Math.round((apiCallsToday / apiLimit) * 100)),
          resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString()
        },
        // Token quota (free plan only)
        tokenQuota: tokenQuota
      }
    };

    // 缓存结果（30秒）
    cache.set(cacheKey, {
      data: responseData,
      expiry: Date.now() + 30000
    });

    res.json(responseData);
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shopId = req.shop.id;

    // 先删除推荐（外键约束）
    const recResult = await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
    // 再删除商品
    const prodResult = await client.query('DELETE FROM "Product" WHERE "shopId" = $1', [shopId]);

    await client.query('COMMIT');
    console.log(`[Admin] Deleted ${prodResult.rowCount} products and ${recResult.rowCount} recommendations for ${req.shop.domain}`);
    cache.clear();
    res.json({
      success: true,
      deleted: recResult.rowCount,
      deletedProducts: prodResult.rowCount,
      deletedRecommendations: recResult.rowCount
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Admin] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// 删除商店的所有商品和推荐
app.delete('/api/products', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shopId = req.shop.id;

    // 先删除推荐（外键约束）
    const recResult = await client.query('DELETE FROM "Recommendation" WHERE "shopId" = $1', [shopId]);
    // 再删除商品
    const prodResult = await client.query('DELETE FROM "Product" WHERE "shopId" = $1', [shopId]);

    await client.query('COMMIT');
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
    await client.query('ROLLBACK');
    console.error('[Admin] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ============ Global Quota Management (Admin Only) ============

// Get current global quota settings
app.get('/api/admin/global-quota', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM "GlobalQuota" WHERE "id" = \'global\'');

    if (result.rows.length === 0) {
      return res.json({
        dailyTokenQuota: 140000000,
        tokensUsedToday: 0,
        quotaResetDate: new Date().toISOString().split('T')[0]
      });
    }

    const quota = result.rows[0];
    res.json({
      dailyTokenQuota: quota.dailyTokenQuota,
      tokensUsedToday: quota.tokensUsedToday,
      quotaResetDate: quota.quotaResetDate,
      updatedAt: quota.updatedAt
    });
  } catch (e) {
    console.error('[Admin] Error getting global quota:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update global quota settings
app.put('/api/admin/global-quota', async (req, res) => {
  try {
    const { dailyTokenQuota } = req.body;

    if (!dailyTokenQuota || dailyTokenQuota < 0) {
      return res.status(400).json({ error: 'Invalid dailyTokenQuota value' });
    }

    // Update or insert global quota
    await pool.query(`
      INSERT INTO "GlobalQuota" ("id", "dailyTokenQuota", "tokensUsedToday", "quotaResetDate", "updatedAt")
      VALUES ('global', $1, 0, $2::date, NOW())
      ON CONFLICT ("id") DO UPDATE SET
        "dailyTokenQuota" = $1,
        "updatedAt" = NOW()
    `, [dailyTokenQuota, new Date().toISOString().split('T')[0]]);

    console.log(`[Admin] Updated global daily token quota to ${dailyTokenQuota}`);

    res.json({
      success: true,
      dailyTokenQuota
    });
  } catch (e) {
    console.error('[Admin] Error updating global quota:', e);
    res.status(500).json({ error: e.message });
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const { plan, shopifySubscriptionId, billingStatus, lastRefreshAt, subscriptionStartedAt, subscriptionEndsAt } = req.body;

    // Get current shop data to check if plan is changing
    const currentShop = await client.query('SELECT * FROM "Shop" WHERE "domain" = $1', [domain]);
    if (currentShop.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shop not found' });
    }

    const oldPlan = currentShop.rows[0].plan || 'free';
    const newPlan = plan || oldPlan;
    const shopId = currentShop.rows[0].id;

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
    if (subscriptionStartedAt !== undefined) {
      updates.push(`"subscriptionStartedAt" = $${paramIndex++}`);
      values.push(subscriptionStartedAt);
    }
    if (subscriptionEndsAt !== undefined) {
      updates.push(`"subscriptionEndsAt" = $${paramIndex++}`);
      values.push(subscriptionEndsAt);
    }
    if (req.body.apiCallsToday !== undefined) {
      updates.push(`"apiCallsToday" = $${paramIndex++}`);
      values.push(req.body.apiCallsToday);
    }

    // If plan is being upgraded (free -> pro/max), reset refresh count
    if (plan !== undefined && oldPlan === 'free' && (newPlan === 'pro' || newPlan === 'max')) {
      updates.push(`"refreshCount" = 0`);
      updates.push(`"refreshMonth" = NULL`);
      console.log(`[Plan] Resetting refresh count for upgrade from ${oldPlan} to ${newPlan}`);
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`"updatedAt" = NOW()`);
    values.push(domain);

    const query = `UPDATE "Shop" SET ${updates.join(', ')} WHERE "domain" = $${paramIndex} RETURNING *`;
    const result = await client.query(query, values);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shop not found' });
    }

    await client.query('COMMIT');

    // 清除缓存
    const cacheKey = `sync-status:${shopId}`;
    cache.delete(cacheKey);
    console.log(`[Plan] Cleared cache for ${cacheKey}`);

    console.log(`[Plan] Updated ${domain}: ${JSON.stringify(req.body)}`);
    res.json({
      success: true,
      ...result.rows[0]
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[Plan] Error:', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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

// ============ 监控 API 端点 ============

// 获取同步日志列表
app.get('/api/monitoring/sync-logs', auth, async (req, res) => {
  try {
    const shopId = req.shop.id;
    const { limit = 100, offset = 0, status } = req.query;

    let query = `
      SELECT sl.*, s.domain as "shopDomain"
      FROM "SyncLog" sl
      JOIN "Shop" s ON sl."shopId" = s.id
      WHERE sl."shopId" = $1
    `;
    const params = [shopId];

    if (status) {
      query += ` AND sl."status" = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY sl."startedAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // 获取总数
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM "SyncLog" WHERE "shopId" = $1 ${status ? 'AND "status" = $2' : ''}`,
      status ? [shopId, status] : [shopId]
    );

    res.json({
      success: true,
      logs: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (e) {
    console.error('[Monitoring] Error fetching sync logs:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取所有商店的同步日志（管理员视图）
app.get('/api/monitoring/all-sync-logs', async (req, res) => {
  try {
    const { limit = 100, offset = 0, shopDomain, status, days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    let query = `
      SELECT sl.*, s.domain as "shopDomain", s.plan
      FROM "SyncLog" sl
      JOIN "Shop" s ON sl."shopId" = s.id
      WHERE sl."startedAt" >= $1
    `;
    const params = [startDate];

    if (shopDomain) {
      query += ` AND s.domain = $${params.length + 1}`;
      params.push(shopDomain);
    }

    if (status) {
      query += ` AND sl."status" = $${params.length + 1}`;
      params.push(status);
    }

    query += ` ORDER BY sl."startedAt" DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    res.json({
      success: true,
      logs: result.rows,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        returned: result.rows.length
      }
    });
  } catch (e) {
    console.error('[Monitoring] Error fetching all sync logs:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取监控统计数据
app.get('/api/monitoring/stats', async (req, res) => {
  try {
    const { shopDomain, days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    let shopFilter = '';
    const params = [startDate];

    if (shopDomain) {
      shopFilter = ` AND s.domain = $2`;
      params.push(shopDomain);
    }

    // 总体统计
    const summaryQuery = `
      SELECT
        COUNT(*) as "totalSyncs",
        COUNT(CASE WHEN sl."status" = 'success' THEN 1 END) as "successfulSyncs",
        COUNT(CASE WHEN sl."status" = 'failed' THEN 1 END) as "failedSyncs",
        SUM(sl."tokensUsed") as "totalTokens",
        SUM(sl."estimatedCost") as "totalCost",
        AVG(sl."durationMs") as "avgDuration",
        SUM(sl."recommendationsGenerated") as "totalRecommendations"
      FROM "SyncLog" sl
      JOIN "Shop" s ON sl."shopId" = s.id
      WHERE sl."startedAt" >= $1 ${shopFilter}
    `;

    const summary = await pool.query(summaryQuery, params);

    // 按天统计
    const dailyQuery = `
      SELECT
        DATE(sl."startedAt") as date,
        COUNT(*) as "syncCount",
        SUM(sl."tokensUsed") as "totalTokens",
        SUM(sl."estimatedCost") as "totalCost",
        AVG(sl."durationMs") as "avgDuration"
      FROM "SyncLog" sl
      JOIN "Shop" s ON sl."shopId" = s.id
      WHERE sl."startedAt" >= $1 AND sl."status" = 'success' ${shopFilter}
      GROUP BY DATE(sl."startedAt")
      ORDER BY date DESC
    `;

    const daily = await pool.query(dailyQuery, params);

    // 按商店统计
    const byShopQuery = `
      SELECT
        s.domain,
        s.plan,
        COUNT(*) as "syncCount",
        SUM(sl."tokensUsed") as "totalTokens",
        SUM(sl."estimatedCost") as "totalCost",
        MAX(sl."startedAt") as "lastSync"
      FROM "SyncLog" sl
      JOIN "Shop" s ON sl."shopId" = s.id
      WHERE sl."startedAt" >= $1 AND sl."status" = 'success' ${shopFilter}
      GROUP BY s.domain, s.plan
      ORDER BY "totalCost" DESC
      LIMIT 20
    `;

    const byShop = await pool.query(byShopQuery, params);

    res.json({
      success: true,
      period: { days: parseInt(days), startDate },
      summary: {
        totalSyncs: parseInt(summary.rows[0].totalSyncs || 0),
        successfulSyncs: parseInt(summary.rows[0].successfulSyncs || 0),
        failedSyncs: parseInt(summary.rows[0].failedSyncs || 0),
        totalTokens: parseInt(summary.rows[0].totalTokens || 0),
        totalCost: parseFloat(summary.rows[0].totalCost || 0),
        avgDuration: parseFloat(summary.rows[0].avgDuration || 0),
        totalRecommendations: parseInt(summary.rows[0].totalRecommendations || 0)
      },
      daily: daily.rows.map(r => ({
        date: r.date,
        syncCount: parseInt(r.syncCount),
        totalTokens: parseInt(r.totalTokens || 0),
        totalCost: parseFloat(r.totalCost || 0),
        avgDuration: parseFloat(r.avgDuration || 0)
      })),
      byShop: byShop.rows.map(r => ({
        domain: r.domain,
        plan: r.plan,
        syncCount: parseInt(r.syncCount),
        totalTokens: parseInt(r.totalTokens || 0),
        totalCost: parseFloat(r.totalCost || 0),
        lastSync: r.lastSync
      }))
    });
  } catch (e) {
    console.error('[Monitoring] Error fetching stats:', e);
    res.status(500).json({ error: e.message });
  }
});

// 获取商店列表（用于管理界面筛选）
app.get('/api/monitoring/shops', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT "id", domain, plan, "apiKey", "productCount", "initialSyncDone", "lastRefreshAt", "subscriptionEndsAt", "createdAt"
      FROM "Shop"
      ORDER BY "createdAt" DESC
    `);

    res.json({
      success: true,
      shops: result.rows
    });
  } catch (e) {
    console.error('[Monitoring] Error fetching shops:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ Whitelist Management API ============

// Get all shops with development store status
app.get('/api/admin/shops', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        "id",
        "domain",
        "plan",
        "planName",
        "isDevelopmentStore",
        "isWhitelisted",
        "productCount",
        "initialSyncDone",
        "lastRefreshAt",
        "createdAt",
        "dailyTokenQuota",
        "tokensUsedToday",
        "quotaResetDate",
        "isSyncEnabled"
      FROM "Shop"
      ORDER BY "createdAt" DESC
    `);

    res.json({
      success: true,
      shops: result.rows
    });
  } catch (e) {
    console.error('[Admin] Error fetching shops:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update shop whitelist status
app.put('/api/admin/shops/:shopId/whitelist', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { isWhitelisted } = req.body;

    if (typeof isWhitelisted !== 'boolean') {
      return res.status(400).json({ error: 'isWhitelisted must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE "Shop" SET "isWhitelisted" = $1, "updatedAt" = NOW() WHERE "id" = $2 RETURNING *`,
      [isWhitelisted, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] Updated whitelist for ${shop.domain}: ${isWhitelisted}`);

    res.json({
      success: true,
      shop: result.rows[0]
    });
  } catch (e) {
    console.error('[Admin] Error updating whitelist:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update shop plan name (for manual correction)
app.put('/api/admin/shops/:shopId/plan-name', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { planName } = req.body;

    if (!planName) {
      return res.status(400).json({ error: 'planName is required' });
    }

    const isDevStore = isDevelopmentStore(planName);

    const result = await pool.query(
      `UPDATE "Shop" SET "planName" = $1, "isDevelopmentStore" = $2, "updatedAt" = NOW() WHERE "id" = $3 RETURNING *`,
      [planName, isDevStore, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] Updated planName for ${shop.domain}: ${planName}, isDevelopmentStore=${isDevStore}`);

    res.json({
      success: true,
      shop: result.rows[0]
    });
  } catch (e) {
    console.error('[Admin] Error updating plan name:', e);
    res.status(500).json({ error: e.message });
  }
});

// Update shop token quota
app.put('/api/admin/shops/:shopId/token-quota', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { dailyTokenQuota } = req.body;

    if (typeof dailyTokenQuota !== 'number' || dailyTokenQuota < 0) {
      return res.status(400).json({ error: 'dailyTokenQuota must be a positive number' });
    }

    const result = await pool.query(
      `UPDATE "Shop" SET "dailyTokenQuota" = $1, "updatedAt" = NOW() WHERE "id" = $2 RETURNING *`,
      [dailyTokenQuota, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] Updated token quota for ${shop.domain}: ${dailyTokenQuota} tokens/day`);

    res.json({
      success: true,
      shop: result.rows[0]
    });
  } catch (e) {
    console.error('[Admin] Error updating token quota:', e);
    res.status(500).json({ error: e.message });
  }
});

// Reset shop token usage (for testing/admin)
app.post('/api/admin/shops/:shopId/reset-tokens', async (req, res) => {
  try {
    const { shopId } = req.params;

    const result = await pool.query(
      `UPDATE "Shop" SET "tokensUsedToday" = 0, "quotaResetDate" = NULL, "updatedAt" = NOW() WHERE "id" = $1 RETURNING *`,
      [shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] Reset token usage for ${shop.domain}`);

    res.json({
      success: true,
      shop: result.rows[0]
    });
  } catch (e) {
    console.error('[Admin] Error resetting tokens:', e);
    res.status(500).json({ error: e.message });
  }
});

// Reset all FREE users' token usage
app.post('/api/admin/reset-all-free-tokens', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE "Shop" SET "tokensUsedToday" = 0, "quotaResetDate" = NULL, "updatedAt" = NOW()
       WHERE "plan" = 'free'
       RETURNING "id", "domain", "tokensUsedToday"`
    );

    const resetCount = result.rows.length;
    console.log(`[Admin] Reset token usage for ${resetCount} FREE shops`);

    res.json({
      success: true,
      resetCount: resetCount,
      shops: result.rows
    });
  } catch (e) {
    console.error('[Admin] Error resetting all free tokens:', e);
    res.status(500).json({ error: e.message });
  }
});

// Toggle shop sync permission
app.put('/api/admin/shops/:shopId/sync-permission', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { isSyncEnabled } = req.body;

    if (typeof isSyncEnabled !== 'boolean') {
      return res.status(400).json({ error: 'isSyncEnabled must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE "Shop" SET "isSyncEnabled" = $1, "updatedAt" = NOW() WHERE "id" = $2 RETURNING *`,
      [isSyncEnabled, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] ${isSyncEnabled ? 'Enabled' : 'Disabled'} sync permission for ${shop.domain}`);

    res.json({
      success: true,
      shop: result.rows[0]
    });
  } catch (e) {
    console.error('[Admin] Error updating sync permission:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ 商店同步管理 API ============

// 手动设置商品数
app.put('/api/admin/shops/:shopId/product-count', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { productCount } = req.body;

    if (typeof productCount !== 'number' || productCount < 0) {
      return res.status(400).json({ error: 'productCount must be a non-negative number' });
    }

    const result = await pool.query(
      `UPDATE "Shop" SET "productCount" = $1, "updatedAt" = NOW() WHERE "id" = $2 RETURNING *`,
      [productCount, shopId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = result.rows[0];
    console.log(`[Admin] Set product count for ${shop.domain}: ${productCount}`);

    res.json({
      success: true,
      shop: result.rows[0],
      message: `Product count set to ${productCount}`
    });
  } catch (e) {
    console.error('[Admin] Error setting product count:', e);
    res.status(500).json({ error: e.message });
  }
});

// 重置同步状态（删除商品和推荐数据）
app.post('/api/admin/shops/:shopId/reset-sync', async (req, res) => {
  try {
    const { shopId } = req.params;

    // 首先获取shop信息，确认shop存在
    const shopCheck = await pool.query(
      `SELECT * FROM "Shop" WHERE "id" = $1`,
      [shopId]
    );

    if (shopCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = shopCheck.rows[0];
    console.log(`[Admin] Resetting sync status for ${shop.domain}...`);

    // 1. 删除该商店的所有推荐数据
    const deleteRecommendationsResult = await pool.query(
      `DELETE FROM "Recommendation"
       WHERE "shopId" = $1`,
      [shopId]
    );
    const deletedRecommendations = deleteRecommendationsResult.rowCount;
    console.log(`[Admin] Deleted ${deletedRecommendations} recommendations for ${shop.domain}`);

    // 2. 删除该商店的所有商品数据
    const deleteProductsResult = await pool.query(
      `DELETE FROM "Product"
       WHERE "shopId" = $1`,
      [shopId]
    );
    const deletedProducts = deleteProductsResult.rowCount;
    console.log(`[Admin] Deleted ${deletedProducts} products for ${shop.domain}`);

    // 3. 重置Shop表的状态字段
    const result = await pool.query(
      `UPDATE "Shop"
       SET "productCount" = 0,
           "initialSyncDone" = false,
           "lastRefreshAt" = NULL,
           "updatedAt" = NOW()
       WHERE "id" = $1
       RETURNING *`,
      [shopId]
    );

    const updatedShop = result.rows[0];
    console.log(`[Admin] Reset sync status completed for ${shop.domain}`);

    res.json({
      success: true,
      shop: updatedShop,
      deletedProducts,
      deletedRecommendations,
      message: `Successfully reset sync status. Deleted ${deletedProducts} products and ${deletedRecommendations} recommendations.`
    });
  } catch (e) {
    console.error('[Admin] Error resetting sync status:', e);
    res.status(500).json({ error: e.message });
  }
});

// 触发重新同步
app.post('/api/admin/shops/:shopId/trigger-sync', async (req, res) => {
  try {
    const { shopId } = req.params;

    // 获取商店信息
    const shopResult = await pool.query(
      `SELECT * FROM "Shop" WHERE "id" = $1`,
      [shopId]
    );

    if (shopResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shop not found' });
    }

    const shop = shopResult.rows[0];

    // 检查同步权限
    if (shop.isSyncEnabled === false) {
      return res.status(403).json({
        error: 'Sync is disabled for this shop',
        message: 'Please enable sync permission first'
      });
    }

    // 重置同步状态，让前端可以重新同步
    await pool.query(
      `UPDATE "Shop"
       SET "initialSyncDone" = false,
           "updatedAt" = NOW()
       WHERE "id" = $1`,
      [shopId]
    );

    console.log(`[Admin] Triggered sync for ${shop.domain}`);

    res.json({
      success: true,
      shop: shop,
      message: `Sync triggered for ${shop.domain}. The shop owner needs to visit the app to complete the sync.`
    });
  } catch (e) {
    console.error('[Admin] Error triggering sync:', e);
    res.status(500).json({ error: e.message });
  }
});

// ============ Start ============
initDatabase().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`AI: ${process.env.DEEPSEEK_API_KEY ? 'ON' : 'OFF'}`);
  });

  // 设置超时时间为 35 分钟（比前端的 30 分钟稍长）
  server.timeout = 2100000; // 35 分钟
  server.headersTimeout = 2100000; // 35 分钟
  server.keepAliveTimeout = 2100000; // 35 分钟

  console.log(`Server timeouts set to 35 minutes`);
}).catch(e => {
  console.error('Failed to start:', e);
  process.exit(1);
});
