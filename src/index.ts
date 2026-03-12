import 'dotenv/config';

// Sealos 外网开发：当内网 DATABASE_URL 不可达时，设置 USE_EXTERNAL_DB=true 使用 DEST_DATABASE_URL
if (process.env.USE_EXTERNAL_DB === 'true' && process.env.DEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DEST_DATABASE_URL;
  process.env.DIRECT_URL = process.env.DEST_DATABASE_URL;
}

import express from 'express';
import cors from 'cors';
import { prisma } from './lib/prisma';
import authRouter    from './routes/auth';
import productRouter from './routes/product';
import orderRouter   from './routes/order';
import userRouter    from './routes/user';
import roleRouter    from './routes/role';
import alibabaRouter from './routes/alibaba';
import shopRouter    from './routes/shop';
import emagRouter    from './routes/emag';
import dashboardRouter from './routes/dashboard';
import storeProductsRouter from './routes/storeProducts';
import { startSyncCrons } from './services/syncCron';
import { backfillProductImages } from './services/storeProductSync';

const app  = express();
const PORT = Number(process.env.PORT) || 3001;

// 启动时校验：JWT_SECRET 与数据库连接
if (!process.env.JWT_SECRET?.trim()) {
  console.error('❌ 启动失败: .env 中 JWT_SECRET 未配置');
  process.exit(1);
}

// ── 中间件 ────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // 兼容 form-urlencoded 登录请求

// ── 路由 ──────────────────────────────────────────────────────
app.use('/api/auth',     authRouter);       // POST /api/auth/login
app.use('/api/products', productRouter);   // GET  /api/products  POST /api/products/:id/select
app.use('/api/orders',         orderRouter);  // POST /api/orders  GET /api/orders  POST /api/orders/sync
app.use('/api/platform-orders', orderRouter); // 别名，兼容前端「平台订单」页面
app.use('/api/users',    userRouter);      // GET POST PATCH DELETE /api/users
app.use('/api/roles',    roleRouter);      // GET /api/roles
app.use('/api/alibaba', alibabaRouter);  // 1688 授权 & 规格关联
app.use('/api/shops',   shopRouter);    // 多平台店铺授权管理
app.use('/api/shop',    shopRouter);    // 别名，兼容前端 /api/shop/:id
app.use('/api/emag',    emagRouter);    // eMAG 核心业务 API
app.use('/api/dashboard', dashboardRouter); // 实时业绩看板
app.use('/api/store-products', storeProductsRouter); // 店铺在售产品（仅 StoreProduct，不混公海）

// ── 启动时打印关键路由（确认 sync-urls 已注册）────────────────────
function printRegisteredRoutes() {
  console.log('\n📋 已注册路由:');
  console.log('   [GET]    /api/shops           ← 店铺列表');
  console.log('   [POST]   /api/shops           ← 新增店铺');
  console.log('   [PUT]    /api/shops/:id       ← 更新店铺（支持 region、shopName，脱敏凭证不覆盖）');
  console.log('   [PATCH]  /api/shops/:id       ← 同上');
  console.log('   [DELETE] /api/shops/:id       ← 删除店铺');
  console.log('   （/api/shop 为 /api/shops 别名）');
  console.log('   POST /api/store-products/sync         ← 手动全量同步平台产品 (shopId)');
  console.log('   POST /api/store-products/sync-urls    ← 补齐 product_url');
  console.log('   POST /api/store-products/sync-images  ← 补齐 main_image');
  console.log('   [POST] /api/orders/sync                ← 平台订单同步（强制重加载）Mounted');
  console.log('   [POST] /api/platform-orders/sync       ← 同上（别名）Mounted');
  console.log('   [POST] /api/orders/sync-platform      ← 同上（兼容旧调用）');
  console.log('   GET  /api/sync-logs                   ← 同步日志');
}

// ── 健康检查 ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ code: 200, data: { status: 'ok' }, message: 'server is running' });
});

// ── 同步日志（验证定时任务）────────────────────────────────────
app.get('/api/sync-logs', async (_req, res) => {
  try {
    const limit = Math.min(50, parseInt(String(_req.query?.limit ?? 20), 10) || 20);
    const logs = await prisma.syncLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ code: 200, data: logs, message: 'success' });
  } catch (e) {
    res.status(500).json({ code: 500, data: null, message: e instanceof Error ? e.message : '服务器错误' });
  }
});

// ── 404 兜底（打印未匹配请求便于排查）────────────────────────────
app.use((req, res) => {
  console.log('[404] 未匹配:', req.method, req.path);
  res.status(404).json({ code: 404, data: null, message: '接口不存在' });
});

// ── 全局错误处理（含 express.json 解析失败）────────────────────
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[express] 未捕获错误:', err instanceof Error ? err.message : err);
  const isParseError = err instanceof SyntaxError;
  res.status(isParseError ? 400 : 500).json({
    code: isParseError ? 400 : 500,
    data: null,
    message: isParseError ? '请求格式错误，请使用 JSON' : '服务器内部错误，请稍后重试',
  });
});

// ── 启动（先校验数据库连接，再全量同步平台订单）──────────────────
async function start() {
  try {
    await prisma.$connect();
    console.log('✅ 数据库连接成功');

    // 强制修正：eMAG 店铺空 region → RO（保证前端站点显示正确）
    const fixed = await prisma.shopAuthorization.updateMany({
      where: {
        platform: { equals: 'emag', mode: 'insensitive' },
        region: null,
      },
      data: { region: 'RO' },
    });
    console.log(`Fixed [${fixed.count}] shops to region RO`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('❌ 数据库连接失败:', msg);
    console.error('   请检查 .env 中 DATABASE_URL 是否正确（Sealos 外网开发可用 DEST_DATABASE_URL）');
    process.exit(1);
  }

  // 暂时停止后台历史订单同步，确保数据库数据正确后再启用
  // const { syncAllPlatformOrders } = await import('./services/platformOrderSync');
  // const { setIsSyncing } = await import('./lib/syncStatus');
  // setIsSyncing(true);
  // syncAllPlatformOrders()...

  app.listen(PORT, () => {
    console.log(`\n🚀 后端服务已启动  →  http://localhost:${PORT}`);
    console.log(`   健康检查: http://localhost:${PORT}/api/health`);
    printRegisteredRoutes();
    startSyncCrons();

    // 启动时异步补齐 main_image 为空或 eMAG Logo 的产品（全局图片回补）
    setImmediate(async () => {
      try {
        const count = await prisma.storeProduct.count({
          where: {
            OR: [
              { mainImage: null },
              { mainImage: '' },
              { mainImage: { contains: 'logo', mode: 'insensitive' } },
              { mainImage: { contains: 'emag-logo', mode: 'insensitive' } },
              { mainImage: { contains: 'placeholder', mode: 'insensitive' } },
              { mainImage: { contains: 'emag-placeholder', mode: 'insensitive' } },
              { mainImage: { contains: 'temporary-images', mode: 'insensitive' } },
              { mainImage: { endsWith: '.svg' } },
            ],
          },
        });
        if (count > 0) {
          console.log(`[启动任务] 发现 ${count} 个无图产品，开始异步补齐 main_image...`);
          const result = await backfillProductImages();
          console.log(`[启动任务] 图片补齐完成，已更新 ${result.updated}/${result.total} 个产品`);
        }
      } catch (e) {
        console.error('[启动任务] 图片补齐失败:', e instanceof Error ? e.message : e);
      }
    });
    console.log('');
  });
}
start();
