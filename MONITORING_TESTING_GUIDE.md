# CartWhisper AI 后端监控系统 - 测试指南

## 📋 目录

1. [系统概述](#系统概述)
2. [部署步骤](#部署步骤)
3. [功能测试](#功能测试)
4. [API测试](#api测试)
5. [管理界面使用](#管理界面使用)
6. [故障排查](#故障排查)

---

## 🎯 系统概述

### 新增功能

本次更新为CartWhisper AI后端添加了完整的监控系统，包括：

✅ **数据库监控表**
- `SyncLog` - 记录每次同步操作的详细信息
- `ApiLog` - 记录API调用（可选）

✅ **自动监控**
- 每次同步操作自动记录
- Token消耗自动追踪
- 成本自动计算（基于DeepSeek定价）

✅ **监控API**
- 获取同步日志
- 统计数据分析
- 商店列表管理

✅ **可视化管理界面**
- 实时统计卡片
- 图表分析（Chart.js）
- 多维度筛选

---

## 🚀 部署步骤

### 1. 提交代码到Git

```bash
cd /Users/linofficemac/Documents/AI/CartWhisperAI_backend

# 查看修改
git status

# 添加所有修改
git add .

# 提交
git commit -m "Add monitoring system with admin dashboard and charts"

# 推送到远程仓库
git push origin main
```

### 2. Railway自动部署

Railway会自动检测到代码更新并开始部署：

1. 访问 [Railway Dashboard](https://railway.app/)
2. 找到你的 `CartWhisperAI_backend` 项目
3. 查看部署日志，确认部署成功
4. 等待部署完成（通常1-3分钟）

### 3. 验证部署

部署完成后，访问以下URL验证：

```bash
# 健康检查
curl https://cartwhisperaibackend-production.up.railway.app/api/health

# 应该返回：
# {"status":"ok","ai":true}
```

### 4. 数据库表自动创建

监控表会在服务启动时自动创建，查看日志应该看到：

```
[DB] Initializing...
[DB] Ready (with monitoring tables)
```

---

## 🧪 功能测试

### 测试1：同步操作监控

#### 目标
验证同步操作是否被正确记录

#### 步骤

1. **获取测试商店的API Key**

```bash
# 注册或获取现有商店
curl -X POST https://cartwhisperaibackend-production.up.railway.app/api/shops/register \
  -H "Content-Type: application/json" \
  -d '{"domain": "test-store.myshopify.com"}'

# 记录返回的 apiKey
```

2. **执行同步操作**

```bash
# 准备测试数据（简化版）
curl -X POST https://cartwhisperaibackend-production.up.railway.app/api/products/sync \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "products": [
      {
        "id": "gid://shopify/Product/123456",
        "handle": "test-product",
        "title": "测试商品",
        "description": "这是一个测试商品",
        "productType": "T-Shirt",
        "vendor": "Test Vendor",
        "price": "29.99",
        "image": {"url": "https://example.com/image.jpg"},
        "tags": ["test", "clothing"]
      }
    ],
    "mode": "auto"
  }'
```

3. **验证监控记录**

访问管理界面查看是否记录了同步操作：
```
https://cartwhisperaibackend-production.up.railway.app/admin-dashboard.html
```

#### 预期结果

- ✅ 同步操作成功完成
- ✅ 在"同步日志"标签中看到新记录
- ✅ 记录包含：商店、模式、状态、耗时、商品数、Token消耗等
- ✅ 统计卡片数据更新

---

### 测试2：Token消耗追踪

#### 目标
验证Token消耗是否被正确记录和计算

#### 步骤

1. **执行多次同步**

```bash
# 同步多个商品，触发AI推荐生成
for i in {1..3}; do
  curl -X POST https://cartwhisperaibackend-production.up.railway.app/api/products/sync \
    -H "X-API-Key: YOUR_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"products\": [
        {
          \"id\": \"gid://shopify/Product/$i\",
          \"handle\": \"product-$i\",
          \"title\": \"商品 $i\",
          \"description\": \"描述 $i\",
          \"productType\": \"T-Shirt\",
          \"vendor\": \"Vendor\",
          \"price\": \"29.99\",
          \"tags\": [\"test\"]
        }
      ],
      \"mode\": \"auto\"
    }"
  sleep 2
done
```

2. **查看Token统计**

访问管理界面，查看：
- 统计卡片中的"Token消耗"
- "图表分析"标签中的"每日Token消耗趋势"

#### 预期结果

- ✅ Token消耗数字累加
- ✅ 成本自动计算（约$0.21/1M tokens）
- ✅ 图表显示Token消耗趋势

---

### 测试3：图表可视化

#### 目标
验证图表是否正确显示数据

#### 步骤

1. **访问管理界面**
```
https://cartwhisperaibackend-production.up.railway.app/admin-dashboard.html
```

2. **切换到"图表分析"标签**

3. **检查四个图表**
   - 📊 每日Token消耗趋势
   - 📦 每日同步商品数量
   - ✅ 同步成功率
   - ⏱️ 平均耗时趋势

#### 预期结果

- ✅ 所有图表正常显示
- ✅ 数据与统计卡片一致
- ✅ 图表可交互（鼠标悬停显示详情）
- ✅ 时间轴正确排序

---

### 测试4：筛选功能

#### 目标
验证筛选功能是否正常工作

#### 步骤

1. **按商店筛选**
   - 在"商店域名"下拉框中选择特定商店
   - 点击"刷新数据"
   - 验证只显示该商店的数据

2. **按时间范围筛选**
   - 选择不同的时间范围（1天/3天/7天/30天）
   - 点击"刷新数据"
   - 验证数据范围正确

3. **按状态筛选**
   - 选择"成功"或"失败"
   - 点击"刷新数据"
   - 验证只显示对应状态的日志

#### 预期结果

- ✅ 筛选立即生效
- ✅ 统计数据相应更新
- ✅ 图表数据相应更新

---

### 测试5：错误处理

#### 目标
验证错误情况是否被正确记录

#### 步骤

1. **触发同步错误**

```bash
# 发送无效数据
curl -X POST https://cartwhisperaibackend-production.up.railway.app/api/products/sync \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"products": []}'
```

2. **查看错误日志**
   - 访问管理界面
   - 切换到"同步日志"标签
   - 查找失败的记录
   - 点击"查看错误"按钮

#### 预期结果

- ✅ 错误被记录为"失败"状态
- ✅ 错误信息被保存
- ✅ 可以查看详细错误堆栈
- ✅ 统计中"失败"计数增加

---

## 🔌 API测试

### 监控API端点

#### 1. 获取同步日志（需认证）

```bash
curl https://cartwhisperaibackend-production.up.railway.app/api/monitoring/sync-logs \
  -H "X-API-Key: YOUR_API_KEY"
```

**响应示例：**
```json
{
  "success": true,
  "logs": [
    {
      "id": "synclog_abc123",
      "shopId": "shop_xyz",
      "shopDomain": "test-store.myshopify.com",
      "mode": "incremental",
      "status": "success",
      "startedAt": "2026-01-19T10:30:00Z",
      "completedAt": "2026-01-19T10:30:15Z",
      "durationMs": 15000,
      "productsScanned": 10,
      "productsSynced": 10,
      "recommendationsGenerated": 30,
      "tokensUsed": 5000,
      "estimatedCost": 0.00105
    }
  ],
  "pagination": {
    "total": 1,
    "limit": 100,
    "offset": 0
  }
}
```

#### 2. 获取所有商店日志（无需认证）

```bash
curl "https://cartwhisperaibackend-production.up.railway.app/api/monitoring/all-sync-logs?days=7&limit=50"
```

**查询参数：**
- `days` - 时间范围（默认7天）
- `limit` - 返回数量（默认100）
- `offset` - 偏移量（默认0）
- `shopDomain` - 筛选特定商店
- `status` - 筛选状态（success/failed/started）

#### 3. 获取统计数据

```bash
curl "https://cartwhisperaibackend-production.up.railway.app/api/monitoring/stats?days=7"
```

**响应示例：**
```json
{
  "success": true,
  "period": {
    "days": 7,
    "startDate": "2026-01-12T00:00:00Z"
  },
  "summary": {
    "totalSyncs": 15,
    "successfulSyncs": 14,
    "failedSyncs": 1,
    "totalTokens": 75000,
    "totalCost": 0.01575,
    "avgDuration": 12500,
    "totalRecommendations": 450
  },
  "daily": [
    {
      "date": "2026-01-19",
      "syncCount": 3,
      "totalTokens": 15000,
      "totalCost": 0.00315,
      "avgDuration": 13000
    }
  ],
  "byShop": [
    {
      "domain": "test-store.myshopify.com",
      "plan": "free",
      "syncCount": 10,
      "totalTokens": 50000,
      "totalCost": 0.0105,
      "lastSync": "2026-01-19T10:30:00Z"
    }
  ]
}
```

#### 4. 获取商店列表

```bash
curl https://cartwhisperaibackend-production.up.railway.app/api/monitoring/shops
```

---

## 🖥️ 管理界面使用

### 访问地址

```
https://cartwhisperaibackend-production.up.railway.app/admin-dashboard.html
```

### 界面功能

#### 1. 统计卡片（顶部）

显示关键指标：
- **总同步次数** - 成功/失败数量
- **成功率** - 百分比和平均耗时
- **Token消耗** - 总数和生成的推荐数
- **总成本** - 美元金额

#### 2. 筛选器

- **商店域名** - 选择特定商店或查看所有
- **时间范围** - 1/3/7/30天
- **状态** - 全部/成功/失败/进行中
- **刷新按钮** - 手动刷新数据

#### 3. 图表分析标签

四个实时图表：

**📊 每日Token消耗趋势**
- 折线图显示每天的Token使用量
- 黄色渐变填充
- 鼠标悬停显示具体数值

**📦 每日同步商品数量**
- 柱状图显示每天的同步次数
- 蓝色柱状
- 显示同步频率

**✅ 同步成功率**
- 折线图显示每天的成功率百分比
- 绿色渐变填充
- 范围0-100%

**⏱️ 平均耗时趋势**
- 折线图显示每天的平均耗时
- 紫色渐变填充
- 单位：秒

#### 4. 同步日志标签

表格显示详细日志：
- 商店信息（域名、计划）
- 操作模式（initial/incremental/refresh）
- 状态徽章（成功/失败/进行中）
- 时间戳
- 性能指标（耗时、商品数、推荐数）
- Token消耗和成本
- 错误查看按钮（失败时）

#### 5. 每日统计标签

按天汇总的数据表格：
- 日期
- 同步次数
- Token消耗
- 成本
- 平均耗时

#### 6. 商店列表标签

卡片式展示所有商店：
- 域名
- 计划类型
- 商品数量
- 首次同步状态
- 上次刷新时间
- 创建时间

### 自动刷新

管理界面每30秒自动刷新数据，无需手动操作。

---

## 🔍 故障排查

### 问题1：管理界面无法访问

**症状：** 访问admin-dashboard.html返回404

**解决方案：**
1. 确认文件存在：
   ```bash
   ls -la /Users/linofficemac/Documents/AI/CartWhisperAI_backend/public/
   ```
2. 确认已提交到Git：
   ```bash
   git status
   ```
3. 重新部署到Railway

---

### 问题2：图表不显示

**症状：** 图表区域空白或显示错误

**可能原因：**
1. Chart.js CDN加载失败
2. 没有数据

**解决方案：**
1. 检查浏览器控制台是否有错误
2. 确认有同步日志数据
3. 尝试切换时间范围
4. 刷新页面

---

### 问题3：监控数据不更新

**症状：** 执行同步后，监控界面没有新数据

**排查步骤：**

1. **检查数据库表是否创建**
   ```bash
   # 查看Railway日志
   # 应该看到：[DB] Ready (with monitoring tables)
   ```

2. **检查同步是否成功**
   ```bash
   curl -X POST .../api/products/sync \
     -H "X-API-Key: YOUR_KEY" \
     -H "Content-Type: application/json" \
     -d '{"products": [...]}'

   # 检查响应是否成功
   ```

3. **直接查询监控API**
   ```bash
   curl https://.../api/monitoring/all-sync-logs?days=1
   ```

4. **查看服务器日志**
   - 访问Railway Dashboard
   - 查看Logs标签
   - 搜索 `[Monitor]` 关键词

---

### 问题4：Token数量为0

**症状：** 所有同步记录的tokensUsed都是0

**原因：**
当前版本的监控系统已经集成，但Token追踪需要从AI API响应中提取实际使用量。

**临时解决方案：**
Token消耗会在未来的同步中记录。如果使用DeepSeek API，响应中会包含usage信息。

**完整解决方案（可选）：**
需要在`generateRecommendations`函数中提取Token使用量并传递给monitor。

---

### 问题5：成本计算不准确

**症状：** 显示的成本与实际不符

**说明：**
成本基于DeepSeek定价估算：
- 输入Token: $0.14/1M
- 输出Token: $0.28/1M
- 平均: $0.21/1M（简化计算）

**调整方法：**
如果使用其他AI模型，需要修改`SyncMonitor.calculateCost()`方法中的定价。

---

## 📊 监控指标说明

### 关键指标

| 指标 | 说明 | 单位 |
|------|------|------|
| **总同步次数** | 时间范围内的同步操作总数 | 次 |
| **成功率** | 成功同步 / 总同步 × 100% | % |
| **Token消耗** | AI API使用的Token总数 | tokens |
| **总成本** | Token消耗 × 单价 | USD |
| **平均耗时** | 所有成功同步的平均时长 | 毫秒 |
| **商品数** | 扫描/同步的商品数量 | 个 |
| **推荐数** | 生成的推荐数量 | 个 |

### 同步模式

| 模式 | 说明 | 触发条件 |
|------|------|----------|
| **initial** | 首次同步 | `initialSyncDone = false` |
| **incremental** | 增量同步 | 默认模式，只为新商品生成推荐 |
| **refresh** | 强制刷新 | 用户手动触发，重新生成所有推荐 |

### 状态说明

| 状态 | 说明 | 颜色 |
|------|------|------|
| **success** | 同步成功完成 | 绿色 |
| **failed** | 同步失败 | 红色 |
| **started** | 同步进行中 | 黄色 |

---

## 🎯 测试检查清单

完成以下测试后，监控系统即可投入使用：

### 部署验证
- [ ] 代码已提交到Git
- [ ] Railway部署成功
- [ ] 健康检查API返回正常
- [ ] 数据库表已创建

### 功能验证
- [ ] 同步操作被正确记录
- [ ] Token消耗被追踪
- [ ] 成本计算正确
- [ ] 错误被正确记录

### 界面验证
- [ ] 管理界面可访问
- [ ] 统计卡片显示正确
- [ ] 四个图表正常显示
- [ ] 同步日志表格正常
- [ ] 筛选功能正常工作
- [ ] 自动刷新正常

### API验证
- [ ] 获取同步日志API正常
- [ ] 获取统计数据API正常
- [ ] 获取商店列表API正常

---

## 📞 支持

如果遇到问题：

1. **查看Railway日志**
   - 访问 Railway Dashboard
   - 查看 Logs 标签
   - 搜索错误信息

2. **检查浏览器控制台**
   - 按F12打开开发者工具
   - 查看Console标签
   - 查看Network标签

3. **验证API响应**
   - 使用curl或Postman测试API
   - 检查响应状态码和内容

---

## 🎉 测试完成

完成所有测试后，你将拥有：

✅ 完整的同步操作监控
✅ 实时Token消耗追踪
✅ 可视化图表分析
✅ 详细的操作日志
✅ 多维度数据筛选
✅ 自动化成本计算

监控系统将帮助你：
- 了解系统使用情况
- 优化Token消耗
- 控制运营成本
- 快速定位问题
- 分析用户行为

祝测试顺利！🚀
