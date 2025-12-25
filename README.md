# CartWhisper Backend

商品推荐 API，部署到 Railway。

## API

| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/products/sync` | 同步商品 + 生成推荐 |
| GET | `/api/recommendations/:productId` | 查询推荐 |
| GET | `/api/health` | 健康检查 |

## 部署到 Railway

### 1. 推送到 GitHub

```bash
git init
git add .
git commit -m "init"
git remote add origin https://github.com/xxx/CartWhisperAI_backend.git
git push -u origin main
```

### 2. Railway 部署

1. 访问 [railway.app](https://railway.app)
2. New Project → Deploy from GitHub
3. 添加 PostgreSQL 数据库
4. 配置环境变量：
   - `DEEPSEEK_API_KEY` - DeepSeek API 密钥

### 3. 创建商店

部署后，在 Railway 数据库中插入商店记录：

```sql
INSERT INTO "Shop" (id, domain, "apiKey", "createdAt")
VALUES (
  'shop_001',
  'your-store.myshopify.com',
  'cw_your_secret_key',
  NOW()
);
```

## 调用示例

### 同步商品

```bash
curl -X POST https://your-app.railway.app/api/products/sync \
  -H "Content-Type: application/json" \
  -H "X-API-Key: cw_your_secret_key" \
  -d '{
    "products": [
      {
        "id": "gid://shopify/Product/123",
        "handle": "product-1",
        "title": "Product 1",
        "price": "99.00"
      }
    ]
  }'
```

### 查询推荐

```bash
curl https://your-app.railway.app/api/recommendations/123 \
  -H "X-API-Key: cw_your_secret_key"
```

响应：

```json
{
  "productId": "123",
  "recommendations": [
    {
      "id": "456",
      "handle": "product-2",
      "title": "Product 2",
      "price": 59.99,
      "image": "https://...",
      "reason": "同类商品推荐"
    }
  ]
}
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接 (Railway 自动设置) |
| `DEEPSEEK_API_KEY` | DeepSeek API 密钥 |
| `PORT` | 端口 (默认 3000) |
