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
app.use('/api/orders',   orderRouter);     // POST /api/orders  GET /api/orders
app.use('/api/users',    userRouter);      // GET POST PATCH DELETE /api/users
app.use('/api/roles',    roleRouter);      // GET /api/roles
app.use('/api/alibaba', alibabaRouter);  // 1688 授权 & 规格关联
app.use('/api/shops',   shopRouter);    // 多平台店铺授权管理
app.use('/api/emag',    emagRouter);    // eMAG 核心业务 API
app.use('/api/dashboard', dashboardRouter); // 实时业绩看板
app.use('/api/store-products', storeProductsRouter); // 店铺在售产品（仅 StoreProduct，不混公海）

// ── 健康检查 ──────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ code: 200, data: { status: 'ok' }, message: 'server is running' });
});

// ── 404 兜底 ──────────────────────────────────────────────────
app.use((_req, res) => {
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
    console.log(`   健康检查: http://localhost:${PORT}/api/health\n`);
  });
}
start();
