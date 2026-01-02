# CartWhisper AI Backend

Shopify 商品智能推荐 API 后端，使用 DeepSeek AI 生成商品推荐。

## 线上地址

```
https://cartwhisperaibackend-production.up.railway.app
```

## 系统架构

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Shopify Store  │─────▶│  CartWhisper    │─────▶│   PostgreSQL    │
│   (Frontend)    │      │    Backend      │      │   (Railway)     │
└─────────────────┘      └────────┬────────┘      └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   DeepSeek AI   │
                        │  (推荐引擎)     │
                        └─────────────────┘
```

## 计划与限额

| 功能 | Free | Pro |
|------|------|-----|
| API 调用次数 | 5,000/天 | 50,000/天 |
| 强制刷新频率 | 30天/次 | 7天/次 |
| 智能同步 | ✅ | ✅ |
| AI 推荐 | ✅ | ✅ |

## API 接口概览

| 方法 | 端点 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 | 无 |
| POST | `/api/shops/register` | 商店注册（自动获取 API Key） | 无 |
| GET | `/api/shops/sync-status` | 获取同步状态和 API 使用量 | X-API-Key |
| GET | `/api/shops/:domain/plan` | 获取商店计划 | 无 |
| PUT | `/api/shops/:domain/plan` | 更新商店计划（测试用） | 无 |
| POST | `/api/products/sync` | 同步商品 + 生成推荐 | X-API-Key |
| GET | `/api/recommendations/:productId` | 查询推荐（需认证） | X-API-Key |
| GET | `/api/storefront/recommendations/:productId` | Storefront 推荐查询 | X-Shop-Domain |
| DELETE | `/api/recommendations` | 删除所有推荐 | X-API-Key |
| DELETE | `/api/products` | 删除所有商品和推荐 | X-API-Key |

### 认证方式

**方式 1: API Key（后台管理）**
```
X-API-Key: cw_xxxxx
```

**方式 2: Shop Domain（Storefront）**
```
X-Shop-Domain: your-store.myshopify.com
```

---

## API 详细说明

### 1. 健康检查

```bash
GET /api/health
```

**响应示例：**
```json
{
  "status": "ok",
  "ai": true
}
```

---

### 2. 商店注册

自动注册商店并获取 API Key。如商店已存在，返回现有 API Key。

```bash
POST /api/shops/register
Content-Type: application/json
```

**请求体：**
```json
{
  "domain": "your-store.myshopify.com"
}
```

**响应示例：**
```json
{
  "success": true,
  "apiKey": "cw_98b991c5c6cf41fc8fd601933b634cfa",
  "isNew": true,
  "message": "Shop registered successfully"
}
```

---

### 3. 获取同步状态

获取商店的同步状态、推荐数量和 API 使用量。

```bash
GET /api/shops/sync-status
X-API-Key: your_api_key
```

**响应示例：**
```json
{
  "success": true,
  "syncStatus": {
    "initialSyncDone": true,
    "lastRefreshAt": "2024-01-15T10:30:00Z",
    "productCount": 50,
    "recommendationCount": 150,
    "plan": "free",
    "canRefresh": false,
    "nextRefreshAt": "2024-02-14T10:30:00Z",
    "daysUntilRefresh": 25,
    "apiUsage": {
      "used": 1234,
      "limit": 5000,
      "remaining": 3766,
      "percentage": 25,
      "resetsAt": "2024-01-16T00:00:00Z"
    }
  }
}
```

---

### 4. 同步商品

支持三种同步模式：

| 模式 | 说明 | 触发条件 |
|------|------|----------|
| `initial` | 首次同步，为所有商品生成推荐 | 首次同步时自动触发 |
| `incremental` | 增量同步，只为新商品生成推荐 | mode=auto 且已完成首次同步 |
| `refresh` | 强制刷新，重新生成所有推荐 | mode=refresh（有频率限制） |

```bash
POST /api/products/sync
Content-Type: application/json
X-API-Key: your_api_key
```

**请求体：**
```json
{
  "products": [
    {
      "id": "gid://shopify/Product/123456",
      "handle": "product-handle",
      "title": "商品名称",
      "description": "商品描述",
      "productType": "商品类型",
      "vendor": "供应商",
      "price": "99.00",
      "image": { "url": "https://cdn.shopify.com/..." },
      "tags": ["标签1", "标签2"]
    }
  ],
  "mode": "auto"
}
```

**mode 参数：**
- `auto`（默认）：智能判断，首次同步完整生成，之后只处理新商品
- `refresh`：强制重新生成所有推荐（受频率限制）

**响应示例（成功）：**
```json
{
  "success": true,
  "mode": "incremental",
  "products": 50,
  "newProducts": 5,
  "newRecommendations": 15,
  "totalRecommendations": 165,
  "canRefresh": true,
  "nextRefreshAt": null
}
```

**响应示例（频率限制）：**
```json
{
  "error": "Refresh rate limit exceeded",
  "nextRefreshAt": "2024-02-14T10:30:00Z",
  "daysRemaining": 25,
  "plan": "free"
}
```

---

### 5. 查询推荐（后台）

```bash
GET /api/recommendations/:productId?limit=3
X-API-Key: your_api_key
```

**参数：**
- `productId` - 商品 ID（不含前缀）或 handle
- `limit` - 返回数量（默认 3，最大 10）

**响应示例：**
```json
{
  "productId": "123456",
  "recommendations": [
    {
      "id": "789012",
      "handle": "recommended-product",
      "title": "推荐商品名称",
      "price": 59.99,
      "image": "https://cdn.shopify.com/...",
      "reason": "完美搭配|Perfect match"
    }
  ]
}
```

---

### 6. Storefront 推荐查询

专为店面前端设计，使用域名认证，受 API 限额控制。

```bash
GET /api/storefront/recommendations/:productId?limit=3
X-Shop-Domain: your-store.myshopify.com
```

**响应格式同上。**

**限额超出响应：**
```json
{
  "error": "API rate limit exceeded",
  "limit": 5000,
  "used": 5000,
  "plan": "free",
  "resetsAt": "2024-01-16T00:00:00Z"
}
```

---

### 7. 管理商店计划（测试用）

**获取计划：**
```bash
GET /api/shops/your-store.myshopify.com/plan
```

**更新计划：**
```bash
PUT /api/shops/your-store.myshopify.com/plan
Content-Type: application/json

{
  "plan": "pro"
}
```

也可用于重置测试数据：
```json
{
  "lastRefreshAt": null,
  "apiCallsToday": 0
}
```

---

## 快速开始

### 1. 部署到 Railway

```bash
# 克隆仓库
git clone https://github.com/yulin6666/CartWhisperAI_backend.git
cd CartWhisperAI_backend

# 推送到你的 GitHub
git remote set-url origin https://github.com/YOUR_USERNAME/CartWhisperAI_backend.git
git push -u origin main
```

在 Railway 控制台：
1. New Project → Deploy from GitHub
2. 添加 PostgreSQL 数据库
3. 配置环境变量 `DEEPSEEK_API_KEY`

### 2. 商店注册

商店会在首次同步时自动注册，也可手动注册：

```bash
curl -X POST https://cartwhisperaibackend-production.up.railway.app/api/shops/register \
  -H "Content-Type: application/json" \
  -d '{"domain": "your-store.myshopify.com"}'
```

### 3. 测试 API

```bash
# 设置环境变量
export BASE_URL="https://cartwhisperaibackend-production.up.railway.app"
export API_KEY="cw_your_api_key"

# 健康检查
curl $BASE_URL/api/health

# 获取同步状态
curl -H "X-API-Key: $API_KEY" $BASE_URL/api/shops/sync-status

# 查询推荐
curl -H "X-API-Key: $API_KEY" "$BASE_URL/api/recommendations/123456?limit=3"
```

---

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串（Railway 自动设置） |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek API 密钥（不设置则使用 fallback 推荐） |
| `PORT` | 否 | 服务端口（默认 3000） |

---

## 数据库结构

### Shop 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| domain | TEXT | Shopify 域名（唯一） |
| apiKey | TEXT | API 密钥（唯一） |
| plan | TEXT | 计划类型（free/pro） |
| initialSyncDone | BOOLEAN | 是否完成首次同步 |
| lastRefreshAt | TIMESTAMP | 上次强制刷新时间 |
| productCount | INTEGER | 商品数量 |
| apiCallsToday | INTEGER | 今日 API 调用次数 |
| apiCallsDate | DATE | API 调用计数日期 |
| shopifySubscriptionId | TEXT | Shopify 订阅 ID |
| billingStatus | TEXT | 计费状态 |
| createdAt | TIMESTAMP | 创建时间 |
| updatedAt | TIMESTAMP | 更新时间 |

### Product 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| shopId | TEXT | 关联商店 |
| productId | TEXT | Shopify 商品 ID |
| handle | TEXT | 商品 handle |
| title | TEXT | 商品名称 |
| description | TEXT | 商品描述 |
| productType | TEXT | 商品类型 |
| vendor | TEXT | 供应商 |
| price | FLOAT | 价格 |
| image | TEXT | 图片 URL |
| tags | TEXT[] | 标签数组 |

### Recommendation 表

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| shopId | TEXT | 关联商店 |
| sourceId | TEXT | 源商品 ID |
| targetId | TEXT | 推荐商品 ID |
| reason | TEXT | 推荐理由（中英双语） |

---

## 同步策略

### 首次同步（Initial）
- 自动检测，无需手动指定
- 为所有商品生成 AI 推荐
- 完成后标记 `initialSyncDone = true`

### 增量同步（Incremental）
- 默认模式（mode=auto）
- 只为新增商品生成推荐
- 已有推荐的商品不重复处理
- 无频率限制

### 强制刷新（Refresh）
- 需指定 mode=refresh
- 删除所有现有推荐，重新生成
- 频率限制：Free 30天/次，Pro 7天/次

---

## 性能与限流

| 项目 | 配置 |
|------|------|
| 推荐缓存 | 5 分钟 |
| 同步限流 | 10 次/分钟 |
| 查询限流 | 300 次/分钟 |
| API 日限额 | Free: 5000, Pro: 50000 |
| 请求体大小 | 50MB |
| 同步超时 | 30 分钟 |

---

## 常用命令

```bash
# 删除所有推荐
curl -X DELETE -H "X-API-Key: $API_KEY" "$BASE_URL/api/recommendations"

# 删除所有商品和推荐
curl -X DELETE -H "X-API-Key: $API_KEY" "$BASE_URL/api/products"

# 查询商店所有推荐
curl -H "X-API-Key: $API_KEY" "$BASE_URL/api/recommendations"

# 切换到 Pro 计划（测试）
curl -X PUT "$BASE_URL/api/shops/your-store.myshopify.com/plan" \
  -H "Content-Type: application/json" \
  -d '{"plan": "pro"}'

# 重置刷新时间（测试）
curl -X PUT "$BASE_URL/api/shops/your-store.myshopify.com/plan" \
  -H "Content-Type: application/json" \
  -d '{"lastRefreshAt": null}'

# 重置 API 调用次数（测试）
curl -X PUT "$BASE_URL/api/shops/your-store.myshopify.com/plan" \
  -H "Content-Type: application/json" \
  -d '{"apiCallsToday": 0}'
```

---

## 目录结构

```
CartWhisperAI_backend/
├── src/
│   └── index.js          # 主程序（所有 API 逻辑）
├── scripts/
│   ├── test-api.sh       # API 测试脚本
│   └── setup-shop.sql    # 商店初始化 SQL
├── package.json          # 项目配置
├── railway.json          # Railway 部署配置
└── README.md             # 本文档
```

---

## 常见问题

### Q: 如何获取 DeepSeek API Key?
访问 [DeepSeek Platform](https://platform.deepseek.com/) 注册并创建 API Key。

### Q: 没有 DeepSeek API Key 可以使用吗？
可以。系统会使用 fallback 逻辑，推荐不同类型的商品作为搭配。

### Q: 为什么推荐的商品类型不同？
这是设计如此。推荐系统会排除同类型商品，推荐互补搭配商品（如：T恤推荐裤子，而不是另一件T恤）。

### Q: API 限额什么时候重置？
每天 UTC 00:00 重置。

### Q: 如何查看剩余 API 调用次数？
1. 调用 `/api/shops/sync-status` 查看 `apiUsage` 字段
2. 查看响应头 `X-RateLimit-Remaining`

### Q: 强制刷新受限怎么办？
- 等待限制时间结束
- 升级到 Pro 计划（7天/次 vs 30天/次）
- 使用增量同步（无限制）

---

## 开发说明

本项目使用原生 `pg` 库直接操作 PostgreSQL，不使用 ORM。

数据库表在应用启动时自动创建和迁移（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`）。
