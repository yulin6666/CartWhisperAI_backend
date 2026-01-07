/**
 * 批量查找可用的 Shopify 商店
 *
 * 用法:
 *   node scripts/find-stores.js [category]
 *
 * 类别: clothing, beauty, shoes, accessories, sports, home
 */

// 已知的 Shopify 商店列表（按类别）
const STORE_DATABASE = {
  clothing: [
    'gymshark',
    'fashionnova',
    'princesspolly',
    'showpo',
    'chubbiesshorts',
    'pfrankmd',
    'goodamerican',
    'skims',
    'fabletics',
    'halara',
    'boohoo',
    'prettylittlething',
    'missguidedus',
    'rebelliousfashion',
    'brandymelvilleusa',
    'americanapparel',
    'lulus',
    'tobi',
    'revolve',
    'aritzia',
    'zara', // 可能不开放
    'hm',   // 可能不开放
    'uniqlo', // 可能不开放
    'neimanmarcus',
    'nordstrom',
    'zappos',
    'asos',
    'bodenusa',
    'everlane',
    'madewell',
    'jcrew',
    'gap',
    'oldnavy',
    'ae',
    'hollister',
    'abercrombie'
  ],
  beauty: [
    'colourpop',
    'kyliecosmetics',
    'jeffreestarcosmetics',
    'morphe',
    'anastasiabeverlyhills',
    'fentybeauty',
    'hudabeauty',
    'tatcha',
    'theordinary',
    'glossier',
    'milkmakeup',
    'rarebeauty',
    'elfcosmetics',
    'narscosmetics',
    'maccosmetics',
    'benefitcosmetics',
    'urbandecay',
    'toofaced',
    'tartecosmetics',
    'nyxcosmetics'
  ],
  shoes: [
    'allbirds',
    'stevemadden',
    'converse',
    'vans',
    'newbalance',
    'asics',
    'saucony',
    'hoka',
    'onrunning',
    'birkenstock',
    'drmartens',
    'timberland',
    'clarks',
    'crocs',
    'skechers',
    'rfrereport',
    'thursdayboots',
    'nativecos',
    'keds',
    'sperrys'
  ],
  accessories: [
    'mvmtwatches',
    'danielwellington',
    'pfrankmd',
    'puravidabracelets',
    'mejuri',
    'baublebar',
    'kendrascott',
    'gorjana',
    'alexmika',
    'ana-luisa',
    'missomaldn',
    'quayaustralia',
    'raybanus',
    'warbyparker',
    'diffeyewear',
    'sunski'
  ],
  sports: [
    'gymshark',
    'alphalete',
    'youngla',
    'buffbunny',
    'nvgtn',
    'oner-active',
    'lululemon', // 可能不开放
    'athleta',
    'outdoor-voices',
    'vuoriclothing',
    'rhone',
    'tenthousand',
    'nobullproject',
    'hylete',
    'bombas',
    'feetures',
    'stance'
  ],
  home: [
    'brooklinen',
    'parachutehome',
    'casper',
    'tuftandneedle',
    'purpleinnovations',
    'ruggable',
    'burrow',
    'article',
    'insidejoybird',
    'westelm',
    'cb2',
    'roomandboard',
    'rejuvenation',
    'worldmarket'
  ]
};

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

async function testStore(storeName) {
  // 尝试不同的域名格式
  const domains = [
    `${storeName}.myshopify.com`,
    `${storeName}.com`,
    `www.${storeName}.com`,
  ];

  for (const domain of domains) {
    try {
      const url = `https://${domain}/products.json?limit=1`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CartWhisper/1.0)'
        }
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data.products && Array.isArray(data.products)) {
          return {
            name: storeName,
            domain: domain,
            available: true,
            productCount: data.products.length > 0 ? 'yes' : 'empty'
          };
        }
      }
    } catch (e) {
      // 继续尝试下一个域名
    }
  }

  return {
    name: storeName,
    domain: null,
    available: false
  };
}

async function findStores(category) {
  const stores = category ? STORE_DATABASE[category] : Object.values(STORE_DATABASE).flat();

  if (!stores || stores.length === 0) {
    log(`\n❌ Unknown category: ${category}`, 'red');
    log('\nAvailable categories: ' + Object.keys(STORE_DATABASE).join(', '), 'cyan');
    return;
  }

  // 去重
  const uniqueStores = [...new Set(stores)];

  log(`\n🔍 Testing ${uniqueStores.length} stores...`, 'cyan');
  log('(This may take a few minutes)\n');

  const results = {
    available: [],
    unavailable: []
  };

  // 分批测试，每批 5 个
  const BATCH_SIZE = 5;
  for (let i = 0; i < uniqueStores.length; i += BATCH_SIZE) {
    const batch = uniqueStores.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(testStore));

    for (const result of batchResults) {
      if (result.available) {
        results.available.push(result);
        log(`  ✅ ${result.name} -> ${result.domain}`, 'green');
      } else {
        results.unavailable.push(result);
        log(`  ❌ ${result.name}`, 'red');
      }
    }
  }

  // 显示结果摘要
  log('\n' + '='.repeat(50), 'cyan');
  log(`\n📊 Results: ${results.available.length}/${uniqueStores.length} stores available\n`, 'cyan');

  if (results.available.length > 0) {
    log('✅ Available stores:', 'green');
    console.log('');
    console.log('| Store | Domain |');
    console.log('|-------|--------|');
    results.available.forEach(r => {
      console.log(`| ${r.name} | ${r.domain} |`);
    });

    // 输出可用于 fetch 命令的列表
    log('\n📋 Quick fetch commands:', 'cyan');
    results.available.slice(0, 5).forEach(r => {
      log(`  node scripts/test-with-real-data.js fetch ${r.name}`);
    });
  }

  // 保存结果到文件
  const outputFile = `test-data/available-stores-${category || 'all'}-${Date.now()}.json`;
  const fs = require('fs');
  const path = require('path');
  const dir = path.dirname(outputFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputFile, JSON.stringify(results.available, null, 2));
  log(`\n💾 Saved to: ${outputFile}`, 'green');
}

function showHelp() {
  log(`
Shopify 商店搜索工具

用法:
  node scripts/find-stores.js [category]

类别:
  clothing     服装商店
  beauty       美妆商店
  shoes        鞋类商店
  accessories  配饰商店
  sports       运动服装
  home         家居用品
  (不填)       测试所有类别

示例:
  node scripts/find-stores.js clothing
  node scripts/find-stores.js beauty
  node scripts/find-stores.js
`, 'cyan');
}

// 主函数
async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  const category = args[0] || null;
  await findStores(category);
}

main();
