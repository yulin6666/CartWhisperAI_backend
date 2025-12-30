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

## API 接口

| 方法 | 端点 | 说明 | 认证 |
|------|------|------|------|
| GET | `/api/health` | 健康检查 | 无 |
| POST | `/api/products/sync` | 同步商品 + 生成推荐 | 需要 |
| GET | `/api/recommendations/:productId` | 查询推荐 | 需要 |

### 认证方式

所有需要认证的接口必须在请求头中包含 `X-API-Key`：

```
X-API-Key: your_api_key_here
```

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

### 2. 同步商品

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
      "image": {
        "url": "https://cdn.shopify.com/..."
      },
      "tags": ["标签1", "标签2"]
    }
  ]
}
```

**响应示例：**
```json
{
  "success": true,
  "products": 10,
  "recommendations": 30
}
```

**说明：**
- 会自动使用 DeepSeek AI 分析商品并生成推荐关系
- 每个商品最多生成 3 个推荐
- 如果 AI 不可用，会使用同类商品作为 fallback

### 3. 查询推荐

```bash
GET /api/recommendations/:productId?limit=3
X-API-Key: your_api_key
```

**参数：**
- `productId` - 商品 ID 或 handle
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
      "reason": "同类热销商品"
    }
  ]
}
```

## 快速开始

### 1. 部署到 Railway

代码已部署在 Railway，如需重新部署：

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

### 2. 创建商店

在 Railway PostgreSQL 控制台执行：

```sql
INSERT INTO "Shop" (id, domain, "apiKey", "createdAt")
VALUES (
  'shop_001',
  'your-store.myshopify.com',
  'cw_your_secret_key_here',
  NOW()
);
```

或使用提供的脚本：
```bash
# 查看 scripts/setup-shop.sql
```

### 3. 测试 API

```bash
# 设置环境变量
export BASE_URL="https://cartwhisperaibackend-production.up.railway.app"
export API_KEY="cw_your_secret_key_here"

# 运行测试脚本
./scripts/test-api.sh
```

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接字符串（Railway 自动设置） |
| `DEEPSEEK_API_KEY` | 否 | DeepSeek API 密钥（不设置则使用 fallback 推荐） |
| `PORT` | 否 | 服务端口（默认 3000） |

## 数据库结构

### Shop 表
| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 主键 |
| domain | TEXT | Shopify 域名（唯一） |
| apiKey | TEXT | API 密钥（唯一） |
| createdAt | TIMESTAMP | 创建时间 |

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
| reason | TEXT | 推荐理由 |

## 性能优化

- **缓存**: 推荐结果缓存 5 分钟
- **限流**:
  - `/api/products/sync`: 10 次/分钟
  - `/api/recommendations`: 300 次/分钟
- **索引**: apiKey 和 sourceId 字段已建立索引

## 测试脚本

```bash
# 完整 API 测试
./scripts/test-api.sh

# 自定义 URL 和 API Key
BASE_URL="https://your-app.railway.app" API_KEY="your_key" ./scripts/test-api.sh
```

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

## 常见问题

### Q: 如何获取 DeepSeek API Key?
访问 [DeepSeek Platform](https://platform.deepseek.com/) 注册并创建 API Key。

### Q: 没有 DeepSeek API Key 可以使用吗？
可以。系统会使用 fallback 逻辑，根据商品类型推荐同类商品。

### Q: 如何修改推荐数量？
在查询时添加 `limit` 参数：`/api/recommendations/123?limit=5`

### Q: 推荐结果缓存多久？
默认 5 分钟。同步商品时会清空所有缓存。

## 开发说明

本项目使用原生 `pg` 库直接操作 PostgreSQL，不使用 ORM，避免了构建时需要数据库连接的问题。

数据库表在应用启动时自动创建（`CREATE TABLE IF NOT EXISTS`）。

## 重要指令

  # 使用您的API Key删除所有推荐
  curl -X DELETE -H "X-API-Key: cw_98b991c5c6cf41fc8fd601933b634cfa" \
    "https://cartwhisperaibackend-production.up.railway.app/api/recommendations"

  # 或者删除所有商品和推荐
  curl -X DELETE -H "X-API-Key: cw_98b991c5c6cf41fc8fd601933b634cfa" \
    "https://cartwhisperaibackend-production.up.railway.app/api/products"

  2. 查询商店所有推荐

  curl -H "X-API-Key: cw_98b991c5c6cf41fc8fd601933b634cfa" \
    "https://cartwhisperaibackend-production.up.railway.app/api/recommendations"
