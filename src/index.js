const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Rate limiting
const syncLimiter = rateLimit({ windowMs: 60000, max: 10 });
const queryLimiter = rateLimit({ windowMs: 60000, max: 300 });

// Cache
const cache = new Map();
const CACHE_TTL = 300000; // 5 minutes

// ============ Auth Middleware ============
async function auth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' });

  const shop = await prisma.shop.findUnique({ where: { apiKey } });
  if (!shop) return res.status(401).json({ error: 'Invalid API key' });

  req.shop = shop;
  next();
}

// ============ DeepSeek AI ============
async function callDeepSeek(prompt) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是电商推荐专家。返回JSON格式，包含recommendations数组，每个元素有productId和reason字段。reason要简短(15字以内)。只返回JSON。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7
      })
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
  } catch (e) {
    console.error('[DeepSeek] Error:', e.message);
    return null;
  }
}

async function generateRecommendations(products) {
  const results = [];

  for (const product of products) {
    const others = products.filter(p => p.productId !== product.productId);
    if (others.length === 0) continue;

    const prompt = `当前商品: ${product.title} (${product.productType || '未分类'}, ¥${product.price})

候选商品:
${others.map((p, i) => `${i + 1}. ID:${p.productId} ${p.title} (${p.productType || '未分类'}, ¥${p.price})`).join('\n')}

选3个最适合搭配的商品，返回格式:
{"recommendations":[{"productId":"xxx","reason":"推荐理由"}]}`;

    const aiResponse = await callDeepSeek(prompt);

    if (aiResponse) {
      try {
        const json = aiResponse.match(/\{[\s\S]*\}/)?.[0];
        const parsed = JSON.parse(json);
        const recs = parsed.recommendations || [];

        for (const rec of recs.slice(0, 3)) {
          const target = others.find(p => p.productId === String(rec.productId));
          if (target) {
            results.push({
              sourceId: product.productId,
              targetId: target.productId,
              reason: rec.reason || ''
            });
          }
        }
      } catch (e) {
        console.error('[AI] Parse error:', e.message);
      }
    } else {
      // Fallback: same type or vendor
      const similar = others
        .filter(p => p.productType === product.productType || p.vendor === product.vendor)
        .slice(0, 3);

      for (const target of similar) {
        results.push({
          sourceId: product.productId,
          targetId: target.productId,
          reason: target.productType === product.productType ? '同类商品' : '同品牌'
        });
      }
    }

    // Rate limit
    if (process.env.DEEPSEEK_API_KEY) await new Promise(r => setTimeout(r, 200));
  }

  return results;
}

// ============ Routes ============

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', ai: !!process.env.DEEPSEEK_API_KEY });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// POST /api/products/sync
app.post('/api/products/sync', syncLimiter, auth, async (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Products array required' });
    }

    const shopId = req.shop.id;
    console.log(`[Sync] Shop ${req.shop.domain}: ${products.length} products`);

    // 1. Save products
    const savedProducts = [];
    for (const p of products) {
      const productId = p.id.replace('gid://shopify/Product/', '');

      const saved = await prisma.product.upsert({
        where: { shopId_productId: { shopId, productId } },
        update: {
          handle: p.handle,
          title: p.title,
          description: p.description || null,
          productType: p.productType || null,
          vendor: p.vendor || null,
          price: parseFloat(p.price) || 0,
          image: p.image?.url || null,
          tags: p.tags || []
        },
        create: {
          shopId,
          productId,
          handle: p.handle,
          title: p.title,
          description: p.description || null,
          productType: p.productType || null,
          vendor: p.vendor || null,
          price: parseFloat(p.price) || 0,
          image: p.image?.url || null,
          tags: p.tags || []
        }
      });

      savedProducts.push(saved);
    }

    console.log(`[Sync] Saved ${savedProducts.length} products`);

    // 2. Generate recommendations
    console.log(`[Sync] Generating recommendations...`);
    const recs = await generateRecommendations(savedProducts);

    // 3. Clear old recommendations
    await prisma.recommendation.deleteMany({ where: { shopId } });

    // 4. Save new recommendations
    let savedCount = 0;
    for (const rec of recs) {
      const source = savedProducts.find(p => p.productId === rec.sourceId);
      const target = savedProducts.find(p => p.productId === rec.targetId);

      if (source && target) {
        await prisma.recommendation.create({
          data: {
            shopId,
            sourceId: source.id,
            targetId: target.id,
            reason: rec.reason
          }
        });
        savedCount++;
      }
    }

    console.log(`[Sync] Saved ${savedCount} recommendations`);

    // Clear cache
    for (const key of cache.keys()) {
      if (key.startsWith(shopId)) cache.delete(key);
    }

    res.json({
      success: true,
      products: savedProducts.length,
      recommendations: savedCount
    });

  } catch (e) {
    console.error('[Sync] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/recommendations/:productId
app.get('/api/recommendations/:productId', queryLimiter, auth, async (req, res) => {
  try {
    const shopId = req.shop.id;
    const { productId } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 3, 10);

    // Check cache
    const cacheKey = `${shopId}:${productId}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      return res.json(cached.data);
    }

    // Find source product
    const source = await prisma.product.findFirst({
      where: {
        shopId,
        OR: [
          { productId },
          { handle: productId }
        ]
      }
    });

    if (!source) {
      return res.json({ productId, recommendations: [] });
    }

    // Get recommendations
    const recs = await prisma.recommendation.findMany({
      where: { shopId, sourceId: source.id },
      include: { target: true },
      take: limit
    });

    const data = {
      productId,
      recommendations: recs.map(r => ({
        id: r.target.productId,
        handle: r.target.handle,
        title: r.target.title,
        price: r.target.price,
        image: r.target.image,
        reason: r.reason
      }))
    };

    // Set cache
    cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL });

    res.json(data);

  } catch (e) {
    console.error('[Query] Error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`CartWhisper Backend running on port ${PORT}`);
  console.log(`AI: ${process.env.DEEPSEEK_API_KEY ? 'Enabled' : 'Disabled'}`);
});
