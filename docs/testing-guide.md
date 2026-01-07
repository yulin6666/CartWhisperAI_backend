# CartWhisper 测试指南

本文档介绍如何使用测试脚本对 CartWhisper 推荐系统进行全面测试。

## 测试脚本位置

```
scripts/test-with-real-data.js
```

## 环境变量配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `BACKEND_URL` | 后端 API 地址 | `https://cartwhisperaibackend-production.up.railway.app` |
| `TEST_PRODUCT_IDS` | 测试产品 ID（逗号分隔） | - |
| `TEST_PRODUCT_ID` | 负载测试使用的单个产品 ID | `123456` |

## 命令说明

### 1. 获取商店产品数据

从任意公开的 Shopify 商店获取产品数据：

```bash
node scripts/test-with-real-data.js fetch <store-name>
```

**示例：**
```bash
# 从 Gymshark 获取产品
node scripts/test-with-real-data.js fetch gymshark

# 从 Allbirds 获取产品
node scripts/test-with-real-data.js fetch allbirds

# 使用完整域名
node scripts/test-with-real-data.js fetch fashion-store.myshopify.com
```

**输出：**
- 产品数据保存到 `test-data/products-<store>-<timestamp>.json`
- 显示产品类型分布统计

---

### 2. 注册测试商店

注册一个新的测试商店并获取 API Key：

```bash
node scripts/test-with-real-data.js register <domain>
```

**示例：**
```bash
node scripts/test-with-real-data.js register my-test-shop.myshopify.com
```

**输出：**
```
🏪 Registering test shop: my-test-shop.myshopify.com
✅ API Key: cw_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> ⚠️ 请保存好 API Key，后续导入产品时需要使用。

---

### 3. 导入产品数据

将产品数据导入到测试商店：

```bash
node scripts/test-with-real-data.js import <json-file> <api-key>
```

**示例：**
```bash
node scripts/test-with-real-data.js import test-data/products-gymshark-1767602468413.json cw_xxxxxxxx
```

**说明：**
- 自动分批导入（每批 50 个产品）
- 首次导入会自动生成推荐
- 免费计划每 30 天只能刷新一次

---

### 4. 测试推荐质量

测试推荐系统的质量：

```bash
node scripts/test-with-real-data.js test <domain> [data-file]
```

**示例：**
```bash
# 使用数据文件随机选择产品测试
node scripts/test-with-real-data.js test my-test-shop.myshopify.com test-data/products-gymshark-xxx.json

# 使用环境变量指定产品 ID
TEST_PRODUCT_IDS=123,456,789 node scripts/test-with-real-data.js test my-test-shop.myshopify.com
```

**输出示例：**
```
🧪 Testing recommendations for: my-test-shop.myshopify.com
Shop has 50 products

📦 Product: 6715424833739
  ✅ Found 3 recommendations:
    1. Gymshark Training Everyday Woven Jacket...
       Reason: 同色系训练夹克，适合健身房|Matching jacket for gym training

📊 Summary:
  Products with recommendations: 5/5 (100%)
  Average recommendations: 3.0 per product
```

---

### 5. 负载测试

测试 API 在并发情况下的性能：

```bash
node scripts/test-with-real-data.js load <domain> [--concurrency=N] [--requests=N]
```

**参数：**
- `--concurrency=N`: 并发数（默认 10）
- `--requests=N`: 总请求数（默认 100）

**示例：**
```bash
# 默认配置（10 并发，100 请求）
node scripts/test-with-real-data.js load my-test-shop.myshopify.com

# 自定义配置
node scripts/test-with-real-data.js load my-test-shop.myshopify.com --concurrency=20 --requests=200

# 指定测试产品
TEST_PRODUCT_ID=6715424833739 node scripts/test-with-real-data.js load my-test-shop.myshopify.com
```

**输出示例：**
```
⚡ Load testing: 10 concurrent, 100 total requests
  Batch 1/10 complete
  ...

📊 Results:
  Success: 100/100 (100.0%)
  Failed: 0
  Avg: 904ms
  P50: 424ms
  P95: 2408ms
  P99: 2408ms
```

---

## 完整测试流程

### 步骤 1: 获取真实商店数据

```bash
node scripts/test-with-real-data.js fetch gymshark
```

### 步骤 2: 注册测试商店

```bash
node scripts/test-with-real-data.js register gymshark-test.myshopify.com
# 输出: ✅ API Key: cw_xxxxx
```

### 步骤 3: 导入产品

```bash
node scripts/test-with-real-data.js import test-data/products-gymshark-xxx.json cw_xxxxx
```

### 步骤 4: 测试推荐质量

```bash
node scripts/test-with-real-data.js test gymshark-test.myshopify.com test-data/products-gymshark-xxx.json
```

### 步骤 5: 负载测试

```bash
TEST_PRODUCT_ID=6715424833739 node scripts/test-with-real-data.js load gymshark-test.myshopify.com
```

---

## API 端点测试

### 公开推荐 API

```bash
curl "https://cartwhisperaibackend-production.up.railway.app/api/public/recommendations/<shop>/<productId>?limit=3"
```

### 追踪 API

```bash
# 记录展示
curl -X POST "https://cartwhisperaibackend-production.up.railway.app/api/tracking/impression" \
  -H "Content-Type: application/json" \
  -d '{"shop":"<domain>","sourceProductId":"123","targetProductIds":["456","789"]}'

# 记录点击
curl -X POST "https://cartwhisperaibackend-production.up.railway.app/api/tracking/click" \
  -H "Content-Type: application/json" \
  -d '{"shop":"<domain>","sourceProductId":"123","targetProductId":"456"}'
```

### 统计 API（需要认证）

```bash
curl "https://cartwhisperaibackend-production.up.railway.app/api/statistics" \
  -H "X-API-Key: cw_xxxxx"
```

---

## 常见问题

### Q: 导入时报 429 错误？

A: 免费计划每 30 天只能刷新一次。请注册新的测试商店或等待刷新周期。

### Q: 导入超时？

A: 大量产品导入时会自动分批处理。如果仍然超时，可以手动分割 JSON 文件。

### Q: 推荐为空？

A: 确保：
1. 产品已成功导入（检查 `/api/shops/<domain>/plan` 的 productCount）
2. 推荐已生成（首次导入后需要等待 AI 生成）
3. 使用正确的产品 ID（纯数字，不是 GID 格式）

---

## 可用的公开 Shopify 商店

以下商店可用于获取测试数据：

- `gymshark` - 运动服装
- `allbirds` - 鞋类
- `fashionnova` - 时尚服装
- `colourpop` - 化妆品
- `kyliecosmetics` - 化妆品
- `mvmtwatches` - 手表
- `chubbiesshorts` - 男装

> 注意：并非所有商店都开放 products.json 接口
