/**
 * CartWhisper 测试脚本 - 使用真实商店数据测试
 *
 * 用法:
 *   node scripts/test-with-real-data.js <command>
 *
 * 命令:
 *   fetch-store <store-url>  - 从公开 Shopify 商店获取产品数据
 *   import-products <file>   - 从 JSON 文件导入产品到测试商店
 *   test-recommendations     - 测试推荐质量
 *   load-test                - 负载测试
 */

const fs = require('fs');
const path = require('path');

// 配置
const BACKEND_URL = process.env.BACKEND_URL || 'https://cartwhisperaibackend-production.up.railway.app';
const TEST_SHOP_DOMAIN = process.env.TEST_SHOP || 'test-store.myshopify.com';

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(msg, color = 'reset') {
  console.log(`${colors[color]}${msg}${colors.reset}`);
}

// 从公开 Shopify 商店获取产品
async function fetchStoreProducts(storeUrl) {
  log(`\n📦 Fetching products from: ${storeUrl}`, 'cyan');

  // 清理 URL
  let baseName = storeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/^www\./, '');

  // 尝试多种域名格式
  const domainsToTry = [];

  if (baseName.includes('.')) {
    // 已经是完整域名
    domainsToTry.push(baseName);
    domainsToTry.push(`www.${baseName}`);
  } else {
    // 只是商店名，尝试各种格式
    domainsToTry.push(`${baseName}.myshopify.com`);
    domainsToTry.push(`${baseName}.com`);
    domainsToTry.push(`www.${baseName}.com`);
  }

  for (const domain of domainsToTry) {
    const url = `https://${domain}/products.json?limit=250`;
    log(`Trying: ${url}`);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        log(`  ❌ ${response.status}`, 'yellow');
        continue;
      }

      const data = await response.json();
      const products = data.products || [];

      if (products.length === 0) {
        log(`  ⚠ No products found`, 'yellow');
        continue;
      }

      log(`✅ Found ${products.length} products from ${domain}`, 'green');

      // 转换为 CartWhisper 格式
      const formatted = products.map(p => ({
        id: String(p.id),
        handle: p.handle,
        title: p.title,
        description: p.body_html?.replace(/<[^>]*>/g, '') || '',
        productType: p.product_type || '',
        vendor: p.vendor || '',
        price: parseFloat(p.variants[0]?.price || 0),
        image: p.images[0]?.src || '',
        tags: Array.isArray(p.tags) ? p.tags : (p.tags ? p.tags.split(', ') : []),
      }));

      // 保存到文件
      const storeName = baseName.split('.')[0];
      const filename = `products-${storeName}-${Date.now()}.json`;
      const filepath = path.join(__dirname, '..', 'test-data', filename);

    // 确保目录存在
      const dir = path.dirname(filepath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(filepath, JSON.stringify(formatted, null, 2));
      log(`💾 Saved to: ${filepath}`, 'green');

      // 显示产品类型分布
      const types = {};
      formatted.forEach(p => {
        const type = p.productType || '(no type)';
        types[type] = (types[type] || 0) + 1;
      });

      log('\n📊 Product types distribution:', 'cyan');
      Object.entries(types)
        .sort((a, b) => b[1] - a[1])
        .forEach(([type, count]) => {
          log(`  ${type}: ${count}`);
        });

      return formatted;
    } catch (error) {
      // 继续尝试下一个域名
      log(`  ❌ ${error.message}`, 'yellow');
      continue;
    }
  }

  log(`\n❌ Could not fetch products from any domain`, 'red');
  return null;
}

// 注册测试商店并获取 API Key
async function registerTestShop(domain) {
  log(`\n🏪 Registering test shop: ${domain}`, 'cyan');

  try {
    const response = await fetch(`${BACKEND_URL}/api/shops/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });

    const data = await response.json();
    if (data.success) {
      log(`✅ API Key: ${data.apiKey}`, 'green');
      return data.apiKey;
    } else {
      throw new Error(data.error || 'Registration failed');
    }
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    return null;
  }
}

// 导入产品到测试商店（分批处理）
async function importProducts(filepath, apiKey, limit = 0) {
  log(`\n📥 Importing products from: ${filepath}`, 'cyan');

  try {
    let allProducts = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    log(`Found ${allProducts.length} products in file`);

    // 如果指定了限制，随机选择产品
    if (limit > 0 && limit < allProducts.length) {
      // 随机打乱数组
      const shuffled = allProducts.sort(() => 0.5 - Math.random());
      allProducts = shuffled.slice(0, limit);
      log(`🎲 Randomly selected ${limit} products for testing`, 'cyan');
    }

    // 分批导入，每批 10 个（减少超时）
    const BATCH_SIZE = 10;
    const batches = Math.ceil(allProducts.length / BATCH_SIZE);
    let totalImported = 0;
    let totalRecommendations = 0;

    for (let i = 0; i < batches; i++) {
      const start = i * BATCH_SIZE;
      const end = Math.min(start + BATCH_SIZE, allProducts.length);
      const products = allProducts.slice(start, end);

      log(`  Batch ${i + 1}/${batches}: importing ${products.length} products...`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout

      try {
        const response = await fetch(`${BACKEND_URL}/api/products/sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': apiKey,
          },
          body: JSON.stringify({ products, mode: 'auto' }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${response.status}: ${text}`);
        }

        const data = await response.json();
        if (data.success) {
          totalImported += data.products || products.length;
          totalRecommendations += data.newRecommendations || 0;
          log(`    ✓ Batch ${i + 1} complete`, 'green');
        } else {
          throw new Error(data.error || 'Batch import failed');
        }
      } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') {
          log(`    ⚠ Batch ${i + 1} timed out, continuing...`, 'yellow');
        } else {
          log(`    ⚠ Batch ${i + 1} failed: ${e.message}`, 'yellow');
        }
      }

      // 批次之间短暂延迟
      if (i < batches - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    log(`\n✅ Import complete: ${totalImported} products`, 'green');
    log(`✅ Generated ${totalRecommendations} recommendations`, 'green');
    return true;
  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
    return false;
  }
}

// 测试推荐质量
async function testRecommendations(domain, dataFile) {
  log(`\n🧪 Testing recommendations for: ${domain}`, 'cyan');

  try {
    // 获取商店状态
    const statusRes = await fetch(`${BACKEND_URL}/api/shops/${domain}/plan`);
    const status = await statusRes.json();

    if (!status.productCount) {
      log('❌ No products in this shop', 'red');
      return;
    }

    log(`Shop has ${status.productCount} products`);

    // 获取测试产品 ID
    let testIds = process.env.TEST_PRODUCT_IDS?.split(',') || [];

    // 如果提供了数据文件，从中获取随机产品
    if (dataFile && fs.existsSync(dataFile)) {
      const products = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      // 随机选择 5 个产品测试
      const shuffled = products.sort(() => 0.5 - Math.random());
      testIds = shuffled.slice(0, 5).map(p => p.id);
      log(`\nSelected ${testIds.length} random products from ${dataFile}`);
    }

    if (testIds.length === 0) {
      log('\n⚠ No test product IDs provided.', 'yellow');
      log('  Set TEST_PRODUCT_IDS=id1,id2,id3 or provide a data file.');
      return;
    }

    log('\n📋 Testing recommendation quality...', 'cyan');

    let totalWithRecs = 0;
    let totalRecs = 0;

    for (const productId of testIds) {
      const recRes = await fetch(
        `${BACKEND_URL}/api/public/recommendations/${encodeURIComponent(domain)}/${productId}?limit=5`
      );
      const recData = await recRes.json();

      log(`\n📦 Product: ${productId}`);

      if (recData.recommendations?.length) {
        totalWithRecs++;
        totalRecs += recData.recommendations.length;
        log(`  ✅ Found ${recData.recommendations.length} recommendations:`, 'green');
        recData.recommendations.forEach((rec, i) => {
          const reason = rec.reasoning || 'no reason';
          log(`    ${i + 1}. ${rec.title.substring(0, 50)}...`);
          log(`       Reason: ${reason}`);
        });
      } else {
        log(`  ⚠ No recommendations found`, 'yellow');
      }
    }

    // 统计
    log('\n📊 Summary:', 'cyan');
    log(`  Products with recommendations: ${totalWithRecs}/${testIds.length} (${(totalWithRecs/testIds.length*100).toFixed(0)}%)`);
    log(`  Average recommendations: ${(totalRecs/testIds.length).toFixed(1)} per product`);

  } catch (error) {
    log(`❌ Error: ${error.message}`, 'red');
  }
}

// 负载测试
async function loadTest(domain, concurrency = 10, requests = 100) {
  log(`\n⚡ Load testing: ${concurrency} concurrent, ${requests} total requests`, 'cyan');

  const productId = process.env.TEST_PRODUCT_ID || '123456';
  const url = `${BACKEND_URL}/api/public/recommendations/${encodeURIComponent(domain)}/${productId}?limit=3`;

  const results = {
    success: 0,
    failed: 0,
    times: [],
  };

  const runRequest = async () => {
    const start = Date.now();
    try {
      const res = await fetch(url);
      const elapsed = Date.now() - start;
      results.times.push(elapsed);
      if (res.ok) {
        results.success++;
      } else {
        results.failed++;
      }
    } catch (e) {
      results.failed++;
    }
  };

  // 分批执行
  const batches = Math.ceil(requests / concurrency);
  for (let i = 0; i < batches; i++) {
    const batchSize = Math.min(concurrency, requests - i * concurrency);
    const promises = Array(batchSize).fill().map(() => runRequest());
    await Promise.all(promises);
    log(`  Batch ${i + 1}/${batches} complete`);
  }

  // 计算统计
  const sorted = results.times.sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];

  log('\n📊 Results:', 'cyan');
  log(`  Success: ${results.success}/${requests} (${(results.success/requests*100).toFixed(1)}%)`);
  log(`  Failed: ${results.failed}`);
  log(`  Avg: ${avg.toFixed(0)}ms`);
  log(`  P50: ${p50}ms`);
  log(`  P95: ${p95}ms`);
  log(`  P99: ${p99}ms`);
}

// 显示帮助
function showHelp() {
  log(`
CartWhisper 测试工具

用法:
  node scripts/test-with-real-data.js <command> [options]

命令:
  fetch <store>              从 Shopify 商店获取产品数据
                             示例: node scripts/test-with-real-data.js fetch allbirds

  register <domain>          注册测试商店
                             示例: node scripts/test-with-real-data.js register test-shop.myshopify.com

  import <file> <api-key>    导入产品数据
                             示例: node scripts/test-with-real-data.js import test-data/products.json sk_xxx

  test <domain>              测试推荐质量
                             设置 TEST_PRODUCT_IDS=id1,id2 来测试特定产品

  load <domain>              负载测试
                             可选: --concurrency=10 --requests=100

环境变量:
  BACKEND_URL                后端 URL (默认: Railway 生产环境)
  TEST_PRODUCT_IDS           要测试的产品 ID，逗号分隔
  TEST_PRODUCT_ID            负载测试用的产品 ID

示例工作流:
  1. 获取真实商店数据:
     node scripts/test-with-real-data.js fetch gymshark

  2. 注册测试商店:
     node scripts/test-with-real-data.js register my-test.myshopify.com

  3. 导入产品数据:
     node scripts/test-with-real-data.js import test-data/products-gymshark-xxx.json sk_xxx

  4. 测试推荐:
     TEST_PRODUCT_IDS=123,456 node scripts/test-with-real-data.js test my-test.myshopify.com
`, 'cyan');
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'fetch':
      if (!args[1]) {
        log('❌ Please provide a store URL', 'red');
        return;
      }
      await fetchStoreProducts(args[1]);
      break;

    case 'register':
      if (!args[1]) {
        log('❌ Please provide a domain', 'red');
        return;
      }
      await registerTestShop(args[1]);
      break;

    case 'import':
      if (!args[1] || !args[2]) {
        log('❌ Please provide filepath and API key', 'red');
        log('Usage: import <file> <api-key> [--limit=N]');
        return;
      }
      const importLimit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1]) || 0;
      await importProducts(args[1], args[2], importLimit);
      break;

    case 'test':
      if (!args[1]) {
        log('❌ Please provide a domain', 'red');
        return;
      }
      // 可选：提供数据文件来随机选择测试产品
      const dataFile = args[2] || null;
      await testRecommendations(args[1], dataFile);
      break;

    case 'load':
      if (!args[1]) {
        log('❌ Please provide a domain', 'red');
        return;
      }
      const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1]) || 10;
      const requests = parseInt(args.find(a => a.startsWith('--requests='))?.split('=')[1]) || 100;
      await loadTest(args[1], concurrency, requests);
      break;

    default:
      showHelp();
  }
}

main();
