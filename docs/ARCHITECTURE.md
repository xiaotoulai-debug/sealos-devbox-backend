# EMAG 跨境电商管理系统 — 架构文档

> 本文档为开发铁律的落地说明，新功能开发前必须静默读取。重大模块完成后需主动询问是否更新。

---

## 1. 后端目录结构树 (Backend Directory Tree)

```
backend/
├── prisma/
│   ├── schema.prisma          # 唯一数据模型定义，表结构修改仅此入口
│   ├── migrations/            # Prisma 迁移历史
│   └── seed.ts                # 初始化角色、权限、种子数据
├── scripts/                   # 独立运维脚本（迁移、补全、诊断）
│   ├── sync-store-products.ts
│   ├── sync-platform-orders.ts
│   ├── backfill-product-images.ts
│   ├── backfill-product-urls.ts
│   └── ...
├── src/
│   ├── index.ts               # 入口：Express 挂载、Cron 启动、健康检查
│   ├── adapters/              # 第三方 API 适配器
│   │   └── onebound.adapter.ts # 万邦 1688 item_get 解析（采购计划规格关联）
│   ├── lib/                   # 基础设施
│   │   ├── prisma.ts          # Prisma Client 单例
│   │   └── syncStatus.ts      # 并发同步锁（防死锁、finally 释放）
│   ├── middleware/
│   │   └── auth.ts            # JWT 认证、requirePermission 权限守卫
│   ├── routes/                # HTTP 路由（无独立 controllers，路由即入口）
│   │   ├── auth.ts            # POST /api/auth/login
│   │   ├── product.ts         # 公海产品 CRUD、入选、采购单
│   │   ├── order.ts           # 采购单、平台订单
│   │   ├── user.ts            # 员工管理
│   │   ├── role.ts            # 角色与权限
│   │   ├── shop.ts            # 店铺授权
│   │   ├── emag.ts            # eMAG 业务（类目、发布、同步触发）
│   │   ├── storeProducts.ts    # 店铺在售产品、手动同步
│   │   ├── dashboard.ts       # 业绩看板
│   │   └── alibaba.ts         # 1688 授权
│   ├── services/              # 核心业务逻辑
│   │   ├── emagClient.ts      # eMAG API 客户端（Adapter）：BaseURL/货币/域名按 region 查表
│   │   ├── emagProduct.ts     # product_offer/read、product/read、documentation/find_by_eans
│   │   ├── emagProductNormalizer.ts  # 唯一 Normalizer：解析、图片提纯、输出统一结构
│   │   ├── storeProductSync.ts       # 两段式同步编排、backfillProductUrls/Images
│   │   ├── ogImageScraper.ts          # @deprecated 已废弃，采用本地关联 SKU 兜底
│   │   ├── productImageCrawler.ts    # @deprecated 已废弃
│   │   ├── platformOrderSync.ts     # 平台订单同步
│   │   ├── inventorySync.ts        # 库存推送到 eMAG
│   │   ├── syncCron.ts              # 订单哨兵(10min)、产品雷达(2h)、库存同步(1h)
│   │   ├── emagRateLimit.ts         # 限流与延迟
│   │   ├── salesStats.ts            # 销售统计
│   │   ├── dashboardStats.ts        # 看板数据
│   │   └── ...
│   └── utils/
│       ├── shopCrypto.ts      # 店铺凭证 AES-256 加解密
│       └── alibaba.ts         # 1688 工具
└── package.json
```

### 核心目录职责

| 目录 | 职责 |
|------|------|
| `src/lib` | 数据库连接、同步锁等基础设施，无业务逻辑 |
| `src/middleware` | 认证与权限校验，`req.user` 注入 `userId/roleId/permissions` |
| `src/routes` | 接收请求、调用 services、返回统一 `{ code, data, message }` |
| `src/services` | 业务逻辑、API 调用、Normalizer、同步编排 |
| `src/utils` | 纯工具函数，无副作用或可复用加解密 |

---

## 2. 动态权限 RBAC 关联图 (Mermaid ER Diagram)

```mermaid
erDiagram
    User }o--|| Role : "role_id"
    Role ||--o{ RolePermission : "has"
    Permission ||--o{ RolePermission : "assigned_to"
    Permission }o--o| Permission : "parent_id"

    User {
        int id PK
        string username UK
        string password_hash
        string name
        int role_id FK
        enum status "ACTIVE|INACTIVE"
    }

    Role {
        int id PK
        string name UK
        string description
    }

    Permission {
        int id PK
        string code UK
        string name
        enum type "MENU|BUTTON|DATA"
        int sort_order
        int parent_id FK "nullable"
    }

    RolePermission {
        int role_id PK,FK
        int permission_id PK,FK
        datetime assigned_at
    }

    User }o--o{ Product : "owns"
    Product {
        int owner_id FK "nullable"
    }
```

### 数据隔离原则（.cursorrules 约定）

- **菜单/按钮级控制**：前端根据 `permissions` 数组渲染菜单与按钮，无权限则不展示。
- **数据级过滤**：涉及业务流转的数据（如入选产品 `Product`、采购单、订单），查询时必须联合 `req.user.userId` 与角色数据权限进行 Prisma 级过滤。例如：
  - 公海产品：`where: { status: 'PENDING' }` 或按角色可见范围
  - 已入选产品：`where: { ownerId: req.user.userId }` 或按数据权限扩展
- **禁止硬编码角色**：不得出现 `if (role === 'ADMIN')`，一律通过 `Permission.code` 判断。

---

## 3. eMAG 核心业务流线图 — 两段式深层抓取 + 本地关联 SKU 兜底

```mermaid
graph TD
    A[定时任务 / 手动触发] --> B[getEmagCredentials 初始化 Adapter]
    B --> C[product_offer/read Offer API 抓取]
    C --> D[Adapter 按 shop.region 查表获取 BaseURL/货币/域名]
    D --> E[Normalizer 清洗 emagProductNormalizer]
    E --> F[images 数组提取 display_type=1 主图]
    F --> G[StoreProduct Upsert 入库 — 有图覆盖/无图保留旧值]
    G --> H[第二阶段: 提取无图 SKU]
    H --> I{documentation/find_by_eans 预拉 EAN 图}
    I --> J[product/read Catalog API 批量抓图]
    J --> K[Normalizer 再次清洗]
    K --> L[补全 main_image 回写 StoreProduct]
    L --> M[GET /api/store-products 列表接口]
    M --> N[Prisma include mappedInventory 联表]
    N --> O[图片回退: emagImage \|\| localImage]
    O --> P[统一输出 image/imageUrl/main_image]
```

### 流程说明

| 阶段 | 组件 | 说明 |
|------|------|------|
| 触发 | `syncCron` / `POST /api/store-products/sync` | 产品雷达每 2 小时；手动可指定 shopId |
| Adapter | `emagClient.getEmagCredentials` | 从 `shop_authorizations` 读取 region，查 `REGION_*` 字典获取 BaseURL、货币、域名 |
| Offer API | `emagProduct.readProductOffers` | `product_offer/read` 分页拉取 SKU、价格、库存 |
| Normalizer | `emagProductNormalizer.normalizeEmagProduct` | 唯一数据清洗管线，无条件信任 eMAG 返回的图片 URL |
| images 主图 | `extractFirstImageFromArray` | 按 eMAG 官方文档：`display_type===1` 为主图 url，无则取首项；支持 JSON 字符串自动解析 |
| Upsert | `prisma.storeProduct.upsert` | `shopId + pnk` 唯一键；有新图片时覆盖，API 无图时保留 DB 已有值（防止清空 1688 绑定图片） |
| 无图提取 | `StoreProduct.findMany` | `mainImage` 为 null 或空 |
| Catalog API | `emagProduct.readProductsByPnk` | `product/read` 批量查询完整产品详情（含 images） |
| 补全入库 | `prisma.storeProduct.updateMany` | 回写 `mainImage`、`imageUrl` |
| **本地关联 SKU 兜底** | `StoreProduct.mappedInventory` | 通过 `mapped_inventory_sku` 关联 `Inventory`，列表接口联表查询；图片优先级：**平台图 > 本地图** |
| 列表接口 | `GET /api/store-products` | `include: { mappedInventory }` 联表；`finalImage = emagImage \|\| localImage`；统一输出 `image`/`imageUrl`/`main_image` |

> **跟卖产品图片说明**：eMAG 的 `product_offer/read` 对跟卖(follow)产品不返回图片。采用【本地关联 SKU 兜底策略】：在后台将平台产品与本地库存 SKU 关联（`mapped_inventory_sku`），列表接口优先返回平台图，无图时自动回退到关联库存的 `local_image`。

---

## 4. 多店销量聚合与综合日销体系

### 4.1 核心字段说明

| 字段 | 所在表 | 说明 |
|------|--------|------|
| `sales_7d` / `sales_14d` / `sales_30d` | `store_products` | 近 7/14/30 天的订单实销量，由 `salesStats.ts` 聚合写入 |
| `comprehensive_sales` | `store_products` | 综合日销 = `(sales7d/7×0.3) + (sales14d/14×0.3) + (sales30d/30×0.4)`，保留两位小数 |

### 4.2 销量聚合管线 (`salesStats.ts`)

**原则：全站通用，绝无 shopId/region 硬编码。**

```
aggregateSalesForShop(shopId)
  └── 从 platform_orders 聚合订单销量
        WHERE shop_id = shopId          ← 动态传入，覆盖所有站点
        AND   status IN (有效状态集)     ← 通过 shopId 关联 region，查表动态匹配
        AND   order_date >= NOW() - INTERVAL '30 days'
  └── 按 vendor_sku（归一化后）GROUP BY，统计 d7/d14/d30 销量
  └── 批量 UPDATE store_products SET sales_7d, sales_14d, sales_30d
  └── 触发 comprehensive_sales 联动计算（见 4.3）
```

**时区处理**：日期窗口（7/14/30天）使用 UTC 统一计算，不依赖店铺所在时区，避免多站点数据不一致。

**订单状态映射**：通过 `shop_authorizations.region` 查 `REGION_CONFIG` 字典，动态获取该站点的有效订单状态（如 RO=`Finalizat`、BG/HU 对应值），不在聚合函数内硬编码任何状态字符串。

### 4.3 综合日销计算与落库

综合日销公式（固化在 `backfillComprehensiveSales` 与 Normalizer 双入口）：

```typescript
const comprehensiveSales = parseFloat(
  ((sales7d / 7) * 0.3 + (sales14d / 14) * 0.3 + (sales30d / 30) * 0.4).toFixed(2)
);
```

**触发时机（两处联动）**：
1. **同步管线触发**：`syncCron.ts` 的 `runProductRadar`（每 2 小时）在 `backfillProductImages` 完成后，自动调用 `backfillComprehensiveSales()`，全站无差别回填。
2. **手动 API 触发**：`POST /api/store-products/backfill-comprehensive-sales` 支持按需全量补算。

### 4.4 服务端排序管线 (`GET /api/store-products`)

前端传入 `sortBy`（snake_case 字段名）和 `sortOrder`（`ascend`/`descend`），后端通过 `FIELD_MAP` 将其转换为 Prisma camelCase 字段并动态注入 `orderBy`：

```
req.query.sortBy = 'comprehensive_sales'
req.query.sortOrder = 'descend'
  └── FIELD_MAP['comprehensive_sales'] → 'comprehensiveSales'
  └── 'descend' → 'desc'
  └── prisma.storeProduct.findMany({ orderBy: { comprehensiveSales: 'desc' } })
```

默认排序：`syncedAt: 'desc'`（最新同步优先）。

### 4.5 多站点数据一致性保障

```mermaid
graph TD
    A[订单哨兵 每10min] --> B[platformOrderSync 同步所有授权店铺]
    B --> C[platform_orders 入库 shop_id 标记]
    C --> D[aggregateSalesForShop 全站通用聚合]
    D --> E[sales_7d/14d/30d 写入 store_products]
    E --> F[comprehensive_sales 联动计算落库]
    G[产品雷达 每2h] --> H[storeProductSync 两段式同步]
    H --> I[backfillProductImages 补图]
    I --> F
```

**防回归机制**：`salesStats.ts` 诊断日志仅输出当前 shopId 下销量最高的 Top3 SKU（动态取值），严禁出现任何硬编码 SKU 或 region 字符串。

---

## 5. 1688 采购计划规格解析（万邦 API）

| 组件 | 说明 |
|------|------|
| `src/adapters/onebound.adapter.ts` | 万邦 1688 item_get Adapter，读取 `ONEBOUND_API_KEY`、`ONEBOUND_API_SECRET` |
| `POST /api/alibaba/parse-link` | 解析 1688 链接 → 调用 `get1688Item(numIid)` → `normalizeOneboundSkus` 提纯 |

**数据提纯**：绝不返回万邦原始 JSON。遍历 `res.item.skus.sku`，映射为 `{ skuId, specName, price, stock }[]`，兼容前端 `specId`/`specName`/`price`/`imageUrl` 结构。

**防坠毁**：`try...catch` 包裹万邦调用，超时 15s，失败返回 `{ code: 500, message: '万邦接口解析失败，请重试或检查链接' }`。

---

## 6. 1688 下单拆单与防错位

| 规则 | 说明 |
|------|------|
| **严格 ID 匹配** | `cargoParamList` 每项 `offerId`/`specId` 必须取自当前 product，禁止循环外共用变量；`specId` 强制 `String()` 转换 |
| **按 offerId 拆单** | 1688 不支持跨店，按 `offerId` 分组，每组独立调用 `alibaba.trade.fastCreateOrder` |
| **脏数据过滤** | 过滤 `externalProductId` 为空或无效的 product，返回友好提示 |
| **强制日志** | 发起 HTTP 请求前打印 `=== FINAL 1688 ORDER PAYLOAD ===` + `=== 1688 ORDER SUBMIT PAYLOAD ===` |
| **specId 双轨** | 1688 期望 specId 为 32 位 MD5 哈希；万邦返回 `spec_id`，优先于纯数字 `sku_id`；cargoParamList 同时传 `specId` 与 `skuId` 双重保险 |

---

## 7. 仪表盘店铺下拉框数据源

| 接口 | 用途 | 过滤条件 |
|------|------|----------|
| `GET /api/shops` | 店铺管理页全量列表 | 无，返回所有店铺 |
| `GET /api/shops/authorized` | 仪表盘下拉框专用 | `platform=emag`、`status=active`，无 region 硬编码 |
| `GET /api/dashboard/shops` | 同上（别名） | 同上 |

**RBAC**：当前架构无 `UserShop` 表，所有已登录用户可见全部 eMAG 活跃店铺，无按 userId 的数据隔离。

**调试日志**：上述接口返回前打印 `=== DASHBOARD SHOPS ===` + `shopName+region` 列表，便于核实后端是否查出完整数据。

---

## 8. 待前端补充

- 前端目录结构
- 路由与页面映射
- 权限码与菜单树对应关系
- 公海/入选/采购单等核心页面交互流

---

*文档版本：基于 backend + prisma/schema.prisma 生成，最后更新：万邦 1688 解析 + 仪表盘店铺下拉框*
