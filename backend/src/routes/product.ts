import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { importPublicSeaFromDisk } from '../services/importPublicSea';

const router = Router();

// 所有产品接口必须登录
router.use(authenticate);

// ── POST /api/products/import-json ──────────────────────────
// 从服务器本地 JSON 文件导入公海产品
router.post('/import-json', async (_req: Request, res: Response) => {
  try {
    console.log('[import-json] 开始导入公海产品 JSON...');
    const result = await importPublicSeaFromDisk();
    res.json({
      code: 200,
      data: result,
      message: `导入完成：${result.totalFiles} 个文件, ${result.totalRecords} 条数据, 新增 ${result.inserted}, 更新 ${result.updated}, 跳过 ${result.skipped}, 错误 ${result.errors}`,
    });
  } catch (err) {
    console.error('[POST /api/products/import-json]', err);
    const msg = err instanceof Error ? err.message : '导入失败';
    res.status(500).json({ code: 500, data: null, message: msg });
  }
});

// ── GET /api/products/brands ──────────────────────────────────
router.get('/brands', async (_req: Request, res: Response) => {
  try {
    const groups = await prisma.product.groupBy({
      by:      ['brand'],
      where:   { status: 'PENDING', brand: { not: null } },
      orderBy: { brand: 'asc' },
    });
    const list = groups
      .map((g) => g.brand?.trim())
      .filter((b): b is string => Boolean(b));
    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/brands]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/tags ────────────────────────────────────
// 返回所有不重复的链接打标值，供前端产品标签列多选筛选
router.get('/tags', async (_req: Request, res: Response) => {
  try {
    const groups = await prisma.product.groupBy({
      by:      ['linkTag'],
      where:   { status: 'PENDING', linkTag: { not: null } },
      orderBy: { linkTag: 'asc' },
    });
    const list = groups
      .map((g) => g.linkTag?.trim())
      .filter((t): t is string => Boolean(t));
    res.json({ code: 200, data: list, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/tags]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/categories ─────────────────────────────────
// 基于 categoryL1-L4 构建真正的四级联动树供前端 Cascader 使用
router.get('/categories', async (_req: Request, res: Response) => {
  try {
    const rows = await prisma.product.findMany({
      where:    { status: 'PENDING' },
      select:   { categoryL1: true, categoryL2: true, categoryL3: true, categoryL4: true },
      distinct: ['categoryL1', 'categoryL2', 'categoryL3', 'categoryL4'],
    });

    const UNCATEGORIZED = 'Uncategorized';
    interface TreeNode { value: string; label: string; children?: TreeNode[] }

    const tree: TreeNode[] = [];
    const l1Map = new Map<string, TreeNode>();

    for (const row of rows) {
      const l1 = row.categoryL1?.trim() || UNCATEGORIZED;

      if (!l1Map.has(l1)) {
        const node: TreeNode = { value: l1, label: l1 };
        l1Map.set(l1, node);
        tree.push(node);
      }
      const l1Node = l1Map.get(l1)!;

      if (l1 === UNCATEGORIZED) continue;

      const l2 = row.categoryL2?.trim();
      if (!l2) continue;
      if (!l1Node.children) l1Node.children = [];
      let l2Node = l1Node.children.find((c) => c.value === l2);
      if (!l2Node) { l2Node = { value: l2, label: l2 }; l1Node.children.push(l2Node); }

      const l3 = row.categoryL3?.trim();
      if (!l3) continue;
      if (!l2Node.children) l2Node.children = [];
      let l3Node = l2Node.children.find((c) => c.value === l3);
      if (!l3Node) { l3Node = { value: l3, label: l3 }; l2Node.children.push(l3Node); }

      const l4 = row.categoryL4?.trim();
      if (!l4) continue;
      if (!l3Node.children) l3Node.children = [];
      if (!l3Node.children.find((c) => c.value === l4)) {
        l3Node.children.push({ value: l4, label: l4 });
      }
    }

    const sortTree = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => a.value.localeCompare(b.value));
      for (const n of nodes) if (n.children) sortTree(n.children);
    };
    sortTree(tree);

    res.json({ code: 200, data: tree, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/categories]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products ─────────────────────────────────────────
// 支持参数：page, pageSize, brand(逗号分隔), pnk(模糊), tag(逗号分隔),
//           categoryPath(JSON 二维数组，如 [["L1","L2"]] 表示按级联路径筛选)
// 返回 { list: Product[], total: number }
router.get('/', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 15), 10) || 15));
    const skip     = (page - 1) * pageSize;

    const brandRaw      = String(req.query.brand        ?? '').trim();
    const pnkRaw        = String(req.query.pnk          ?? '').trim();
    const tagRaw        = String(req.query.tag           ?? '').trim();
    const cpRaw         = String(req.query.categoryPath  ?? '').trim();
    const priceRangeRaw = String(req.query.priceRange    ?? '').trim();
    const eligibleOnly  = String(req.query.eligibleOnly  ?? '').trim() === 'true';

    const brandList = brandRaw ? brandRaw.split(',').map((b) => b.trim()).filter(Boolean) : [];
    const tagList   = tagRaw   ? tagRaw.split(',').map((t) => t.trim()).filter(Boolean)   : [];

    let categoryPaths: string[][] = [];
    if (cpRaw) {
      try {
        const parsed = JSON.parse(cpRaw);
        if (Array.isArray(parsed)) categoryPaths = parsed.filter(Array.isArray);
      } catch { /* ignore */ }
    }

    const canSeeCost = req.user!.permissions.includes('DATA_HIDE_PRICE');

    console.log('[GET /api/products] filters →', { brandList, pnkRaw, tagList, categoryPaths, priceRangeRaw, page, pageSize });

    const where: Record<string, unknown> = { status: 'PENDING' as const };
    if (brandList.length > 0) where.brand   = { in: brandList };
    if (tagList.length   > 0) where.linkTag = { in: tagList };
    if (pnkRaw)               where.pnk     = { contains: pnkRaw, mode: 'insensitive' };

    if (priceRangeRaw === 'under50')  where.price = { lt: 50 };
    else if (priceRangeRaw === '50to150') where.price = { gte: 50, lte: 150 };
    else if (priceRangeRaw === 'over150') where.price = { gt: 150 };

    if (categoryPaths.length > 0) {
      const FIELDS = ['categoryL1', 'categoryL2', 'categoryL3', 'categoryL4'] as const;
      const UNCATEGORIZED = 'Uncategorized';

      const catConditions = categoryPaths
        .map((path) => {
          if (path[0] === UNCATEGORIZED) {
            return { OR: [{ categoryL1: null }, { categoryL1: '' }] } as Record<string, unknown>;
          }
          const c: Record<string, unknown> = {};
          path.forEach((v, i) => { if (v && i < 4) c[FIELDS[i]] = v; });
          return Object.keys(c).length > 0 ? c : null;
        })
        .filter((c): c is Record<string, unknown> => c !== null);

      if (catConditions.length === 1) {
        const cond = catConditions[0];
        if (cond.OR) {
          where.AND = [cond];
        } else {
          Object.assign(where, cond);
        }
      } else if (catConditions.length > 1) {
        where.AND = [{ OR: catConditions }];
      }
    }

    if (eligibleOnly) {
      const eligibleCond = {
        OR: [
          { AND: [{ rating: { gte: 3.5 } }, { reviewCount: { gte: 1 } }] },
          { linkTag: { contains: 'Top Favorite', mode: 'insensitive' as const } },
        ],
      };
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), eligibleCond];
    }

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take: pageSize }),
    ]);

    const list = products.map((p) => ({
      id:          p.id,
      pnk:         p.pnk,
      title:       p.title,
      brand:       p.brand,
      category:    p.category,
      categoryL1:  p.categoryL1 ?? null,
      categoryL2:  p.categoryL2 ?? null,
      categoryL3:  p.categoryL3 ?? null,
      categoryL4:  p.categoryL4 ?? null,
      price:       p.price       ? Number(p.price)  : null,
      costPrice:   canSeeCost && p.costPrice ? Number(p.costPrice) : null,
      stock:       p.stock,
      rating:      p.rating      ? Number(p.rating) : null,
      reviewCount: p.reviewCount,
      tags:        p.tags,
      imageUrl:    p.imageUrl,
      productUrl:  p.productUrl,
      linkTag:     p.linkTag ?? null,
      status:      p.status,
      createdAt:   p.createdAt,
    }));

    res.json({ code: 200, data: { list, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/private/generate-sku ────────────────────
// 企业级 SKU 生成引擎 v2：3字母前缀 + '#' + 3位流水号（如 MOB#001）
const SKU_PREFIX_MAP: Record<string, string> = {
  '手机及配件':      'MOB',
  '手机配件':        'MAC',
  '笔记本及配件':    'LAP',
  '笔记本电脑':      'LPC',
  '笔记本配件':      'LAC',
  '平板及配件':      'TAB',
  '电脑组件':        'PCC',
  '台式机与显示器':  'DKM',
  '外设与配件':      'PRH',
  '键盘与鼠标':      'KBM',
  '显示器':          'MNT',
  '内存':            'MEM',
  '网络与服务器':    'NTS',
  '软件':            'SFT',
  '电脑外设':        'PCR',
  '手机壳':          'CSE',
  '手机充电器':      'CHG',
  '手机保护膜':      'FLM',
  '手机数据线':      'CBL',
  '手机充电宝':      'PWB',
  '存储卡':          'SDC',
  '读卡器':          'CRD',
  '自拍杆':          'SLF',
  '电脑、外设与软件': 'CPS',
  '耳机':            'EAR',
  '音箱':            'SPK',
  '摄像头':          'CAM',
  '路由器':          'RTR',
};

const VOWELS = new Set('aeiouAEIOU');

function consonantPrefix(original: string): string {
  const letters = original.replace(/[^A-Za-z]/g, '');
  if (letters.length === 0) return 'GNX';
  const first = letters[0].toUpperCase();
  const consonants: string[] = [];
  for (let i = 1; i < letters.length && consonants.length < 2; i++) {
    if (!VOWELS.has(letters[i])) consonants.push(letters[i].toUpperCase());
  }
  return (first + consonants.join('') + 'XX').slice(0, 3);
}

function generatePrefix(categoryZh?: string, originalCat?: string): string {
  if (categoryZh && SKU_PREFIX_MAP[categoryZh]) return SKU_PREFIX_MAP[categoryZh];
  if (originalCat) return consonantPrefix(originalCat);
  return 'GNX';
}

router.get('/private/generate-sku', async (req: Request, res: Response) => {
  try {
    const categoryZh  = String(req.query.categoryZh  ?? '').trim();
    const originalCat = String(req.query.originalCat  ?? '').trim();

    const prefix = generatePrefix(categoryZh || undefined, originalCat || undefined);
    const searchPrefix = prefix + '#';

    const latest = await prisma.product.findFirst({
      where: { sku: { startsWith: searchPrefix } },
      orderBy: { sku: 'desc' },
      select: { sku: true },
    });

    let seq = 1;
    if (latest?.sku) {
      const parts = latest.sku.split('#');
      const parsed = parseInt(parts[1] ?? '', 10);
      if (!isNaN(parsed)) seq = parsed + 1;
    }

    const sku = `${prefix}#${String(seq).padStart(3, '0')}`;
    res.json({ code: 200, data: { sku, prefix }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/private/generate-sku]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/private ──────────────────────────────────
// 拉取当前用户的私有产品库，含财务数据，按采集时间倒序
router.get('/private', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    const where = { status: 'SELECTED' as const, ownerId: req.user!.userId };

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ collectedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const list = products.map((p) => ({
      id:            p.id,
      pnk:           p.pnk,
      title:         p.title,
      brand:         p.brand,
      category:      p.category,
      price:         p.price         ? Number(p.price)         : null,
      imageUrl:      p.imageUrl,
      productUrl:    p.productUrl,
      linkTag:       p.linkTag       ?? null,
      rating:        p.rating        ? Number(p.rating)        : null,
      reviewCount:   p.reviewCount,
      purchasePrice: p.purchasePrice ? Number(p.purchasePrice) : null,
      purchaseUrl:   p.purchaseUrl   ?? null,
      actualWeight:  p.actualWeight  ? Number(p.actualWeight)  : null,
      length:        p.length        ? Number(p.length)        : null,
      width:         p.width         ? Number(p.width)         : null,
      height:        p.height        ? Number(p.height)        : null,
      freightCost:   p.freightCost   ? Number(p.freightCost)   : null,
      fbeFee:        p.fbeFee        ? Number(p.fbeFee)        : null,
      margin:        p.margin        ? Number(p.margin)        : null,
      sku:              p.sku              ?? null,
      chineseName:      p.chineseName      ?? null,
      developer:        p.developer        ?? null,
      purchaseQuantity: p.purchaseQuantity ?? null,
      purchasePeriod:   p.purchasePeriod   ?? null,
      stock:            p.stock,
      categoryL2:       p.categoryL2       ?? null,
      handlingTime:  p.handlingTime,
      vat:           p.vat,
      publishStatus: p.publishStatus,
      collectedAt:   p.collectedAt,
      updatedAt:     p.updatedAt,
    }));

    res.json({ code: 200, data: { list, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/private]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/:id/publish ─────────────────────────────
// 确认采购：保存 SKU、中文名、采购数量、采购周期，状态变为 PURCHASING
router.put('/:id/publish', async (req: Request, res: Response) => {
  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) {
    res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
    return;
  }

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }
    if (product.status !== 'SELECTED' || product.ownerId !== req.user!.userId) {
      res.status(403).json({ code: 403, data: null, message: '无权操作该产品' });
      return;
    }

    const { sku, cnName, stock, handlingTime, price, length: pLen, width: pWid, height: pHei, weight: pWgt, purchaseType } = req.body ?? {};
    if (!sku || typeof sku !== 'string' || !sku.trim()) {
      res.status(400).json({ code: 400, data: null, message: 'SKU 不能为空' });
      return;
    }

    await prisma.product.update({
      where: { id: productId },
      data: {
        sku:              sku.trim(),
        chineseName:      typeof cnName === 'string' && cnName.trim() ? cnName.trim() : null,
        purchaseQuantity: stock        != null ? Number(stock)        : 20,
        purchasePeriod:   handlingTime != null ? Number(handlingTime) : 5,
        stock:            stock        != null ? Number(stock)        : 20,
        handlingTime:     handlingTime != null ? Number(handlingTime) : 5,
        purchasePrice:    price        != null ? Number(price)        : undefined,
        length:           pLen         != null ? Number(pLen)         : null,
        width:            pWid         != null ? Number(pWid)         : null,
        height:           pHei         != null ? Number(pHei)         : null,
        actualWeight:     pWgt         != null ? Number(pWgt)         : undefined,
        purchaseType:     typeof purchaseType === 'string' && purchaseType.trim() ? purchaseType.trim() : 'FIRST',
        publishStatus:    'PUBLISHED',
        status:           'PURCHASING',
      },
    });

    res.json({ code: 200, data: null, message: '已加入采购' });
  } catch (err: unknown) {
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002') {
      res.status(400).json({ code: 400, data: null, message: '该 SKU 已存在，请换一个' });
      return;
    }
    console.error('[PUT /api/products/:id/publish]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/purchasing ──────────────────────────────
// 采购清单：拉取状态为 PURCHASING 的产品
router.get('/purchasing', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    const where = { status: 'PURCHASING' as const, ownerId: req.user!.userId };

    const [total, products] = await prisma.$transaction([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    const list = products.map((p) => ({
      id:               p.id,
      pnk:              p.pnk,
      title:            p.title,
      brand:            p.brand,
      category:         p.category,
      price:            p.price         ? Number(p.price)         : null,
      imageUrl:         p.imageUrl,
      productUrl:       p.productUrl,
      purchasePrice:    p.purchasePrice ? Number(p.purchasePrice) : null,
      purchaseUrl:      p.purchaseUrl   ?? null,
      margin:           p.margin        ? Number(p.margin)        : null,
      sku:              p.sku           ?? null,
      chineseName:      p.chineseName   ?? null,
      developer:        p.developer     ?? null,
      purchaseQuantity: p.purchaseQuantity ?? null,
      purchasePeriod:   p.purchasePeriod   ?? null,
      purchaseType:     p.purchaseType     ?? 'FIRST',
      length:           p.length        ? Number(p.length)        : null,
      width:            p.width         ? Number(p.width)         : null,
      height:           p.height        ? Number(p.height)        : null,
      actualWeight:     p.actualWeight  ? Number(p.actualWeight)  : null,
      externalProductId: p.externalProductId ?? null,
      externalSkuId:     p.externalSkuId     ?? null,
      externalSynced:    p.externalSynced    ?? false,
      externalOrderId:   p.externalOrderId   ?? null,
      updatedAt:        p.updatedAt,
    }));

    res.json({ code: 200, data: { list, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/purchasing]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/inventory ───────────────────────────────
// 库存 SKU 列表：查询所有已建库（sku 非空）的产品
router.get('/inventory', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const pageNum  = Math.max(1, Number(req.query.page)     || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const keyword  = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';

    const where: Record<string, unknown> = {
      ownerId: userId,
      sku: { not: null },
    };

    if (keyword) {
      where.OR = [
        { sku:         { contains: keyword, mode: 'insensitive' } },
        { chineseName: { contains: keyword, mode: 'insensitive' } },
      ];
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where: where as any,
        orderBy: { updatedAt: 'desc' },
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
      prisma.product.count({ where: where as any }),
    ]);

    const list = products.map((p) => ({
      id:             p.id,
      pnk:            p.pnk,
      title:          p.title,
      brand:          p.brand,
      sku:            p.sku,
      chineseName:    p.chineseName   ?? null,
      developer:      p.developer     ?? null,
      imageUrl:       p.imageUrl,
      price:          p.price         ? Number(p.price)         : null,
      purchasePrice:  p.purchasePrice ? Number(p.purchasePrice) : null,
      purchaseUrl:    p.purchaseUrl   ?? null,
      length:         p.length        ? Number(p.length)        : null,
      width:          p.width         ? Number(p.width)         : null,
      height:         p.height        ? Number(p.height)        : null,
      actualWeight:   p.actualWeight  ? Number(p.actualWeight)  : null,
      stockActual:    p.stockActual,
      stockInTransit: p.stockInTransit,
      sales7d:        p.sales7d,
      sales14d:       p.sales14d,
      sales30d:       p.sales30d,
      status:         p.status,
      publishStatus:  p.publishStatus,
      externalProductId: p.externalProductId ?? null,
      externalSkuId:     p.externalSkuId     ?? null,
      updatedAt:      p.updatedAt,
    }));

    res.json({ code: 200, data: { list, total }, message: 'success' });
  } catch (err) {
    console.error('[GET /api/products/inventory]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/:id/recalculate ─────────────────────────
// 更新私有池产品的利润核算数据
router.put('/:id/recalculate', async (req: Request, res: Response) => {
  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) {
    res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
    return;
  }

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }
    if (product.status !== 'SELECTED' || product.ownerId !== req.user!.userId) {
      res.status(403).json({ code: 403, data: null, message: '无权操作该产品' });
      return;
    }

    const { sku, purchasePrice, purchaseUrl, chineseName, developer, actualWeight, freightCost, fbeFee, margin, length: pLen, width: pWid, height: pHei } = req.body ?? {};

    let devName = typeof developer === 'string' && developer.trim() ? developer.trim() : null;
    if (!devName) {
      const currentUser = await prisma.user.findUnique({ where: { id: req.user!.userId }, select: { name: true } });
      devName = currentUser?.name ?? req.user!.username ?? null;
    }

    await prisma.product.update({
      where: { id: productId },
      data: {
        sku:           typeof sku === 'string' && sku.trim() ? sku.trim() : undefined,
        purchasePrice: purchasePrice != null ? Number(purchasePrice) : null,
        purchaseUrl:   typeof purchaseUrl === 'string' && purchaseUrl.trim() ? purchaseUrl.trim() : null,
        chineseName:   typeof chineseName === 'string' && chineseName.trim() ? chineseName.trim() : null,
        developer:     devName,
        actualWeight:  actualWeight  != null ? Number(actualWeight)  : null,
        freightCost:   freightCost   != null ? Number(freightCost)   : null,
        fbeFee:        fbeFee        != null ? Number(fbeFee)        : null,
        margin:        margin        != null ? Number(margin)        : null,
        length:        pLen          != null ? Number(pLen)          : null,
        width:         pWid          != null ? Number(pWid)          : null,
        height:        pHei          != null ? Number(pHei)          : null,
      },
    });

    res.json({ code: 200, data: null, message: '建库数据已保存' });
  } catch (err: unknown) {
    const prismaErr = err as { code?: string; meta?: { target?: string[] } };
    if (prismaErr.code === 'P2002' && prismaErr.meta?.target?.includes('sku')) {
      res.status(409).json({ code: 409, data: null, message: '该 SKU 已被其他产品占用，请手动修改后重试' });
      return;
    }
    console.error('[PUT /api/products/:id/recalculate]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── DELETE /api/products/:id/reject ──────────────────────────
// 淘汰回公海：重置状态 + 清空私有财务字段
router.delete('/:id/reject', async (req: Request, res: Response) => {
  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) {
    res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
    return;
  }

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }
    if (product.status !== 'SELECTED' || product.ownerId !== req.user!.userId) {
      res.status(403).json({ code: 403, data: null, message: '无权操作该产品' });
      return;
    }

    await prisma.product.update({
      where: { id: productId },
      data: {
        status:        'PENDING',
        ownerId:       null,
        collectedAt:   null,
        purchasePrice: null,
        purchaseUrl:   null,
        actualWeight:  null,
        freightCost:   null,
        fbeFee:        null,
        margin:        null,
      },
    });

    res.json({ code: 200, data: null, message: '已淘汰回公海' });
  } catch (err) {
    console.error('[DELETE /api/products/:id/reject]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/products/:id/select ────────────────────────────
// 将公海产品加入当前用户的私有入选池，同时保存利润测算数据
router.post('/:id/select', async (req: Request, res: Response) => {
  if (!req.user!.permissions.includes('BTN_SELECT_PRODUCT')) {
    res.status(403).json({ code: 403, data: null, message: '无操作权限' });
    return;
  }

  const productId = Number(req.params.id);
  if (Number.isNaN(productId)) {
    res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
    return;
  }

  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }
    if (product.status === 'SELECTED') {
      res.status(409).json({ code: 409, data: null, message: '该产品已被加入私有池' });
      return;
    }

    const { purchasePrice, actualWeight, freightCost, fbeFee, margin, purchaseUrl, chineseName, length: pLen, width: pWid, height: pHei } = req.body ?? {};

    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        status:        'SELECTED',
        ownerId:       req.user!.userId,
        collectedAt:   new Date(),
        purchasePrice: purchasePrice != null ? Number(purchasePrice) : null,
        purchaseUrl:   typeof purchaseUrl === 'string' && purchaseUrl.trim() ? purchaseUrl.trim() : null,
        chineseName:   typeof chineseName === 'string' && chineseName.trim() ? chineseName.trim() : null,
        actualWeight:  actualWeight  != null ? Number(actualWeight)  : null,
        freightCost:   freightCost   != null ? Number(freightCost)   : null,
        fbeFee:        fbeFee        != null ? Number(fbeFee)        : null,
        margin:        margin        != null ? Number(margin)        : null,
        length:        pLen          != null ? Number(pLen)          : null,
        width:         pWid          != null ? Number(pWid)          : null,
        height:        pHei          != null ? Number(pHei)          : null,
      },
    });

    res.json({ code: 200, data: { id: updated.id, status: updated.status }, message: '已成功加入私有池' });
  } catch (err) {
    console.error('[POST /api/products/:id/select]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/batch-update ────────────────────────────
// 批量逐行修改采购计划中产品的物流/采购参数
// body: { items: [{ id, chineseName?, length?, width?, height?, actualWeight?, purchasePrice?, purchaseQuantity? }, ...] }
router.put('/batch-update', async (req: Request, res: Response) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '没有需要更新的数据' });
      return;
    }

    const userId = req.user!.userId;
    let count = 0;

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const id = Number(item.id);
        if (isNaN(id)) continue;

        const data: Record<string, unknown> = {};
        if (item.chineseName      !== undefined) data.chineseName      = typeof item.chineseName === 'string' && item.chineseName.trim() ? item.chineseName.trim() : null;
        if (item.length           !== undefined) data.length           = item.length != null ? Number(item.length) : null;
        if (item.width            !== undefined) data.width            = item.width != null ? Number(item.width) : null;
        if (item.height           !== undefined) data.height           = item.height != null ? Number(item.height) : null;
        if (item.actualWeight     !== undefined) data.actualWeight     = item.actualWeight != null ? Number(item.actualWeight) : null;
        if (item.purchasePrice    !== undefined) data.purchasePrice    = item.purchasePrice != null ? Number(item.purchasePrice) : null;
        if (item.purchaseQuantity !== undefined) data.purchaseQuantity = item.purchaseQuantity != null ? Number(item.purchaseQuantity) : null;

        if (Object.keys(data).length === 0) continue;

        const result = await tx.product.updateMany({
          where: { id, status: 'PURCHASING', ownerId: userId },
          data,
        });
        count += result.count;
      }
    });

    res.json({ code: 200, data: { count }, message: `已更新 ${count} 个产品` });
  } catch (err) {
    console.error('[PUT /api/products/batch-update]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/batch-rollback ─────────────────────────
// 批量将产品从 PURCHASING 退回 SELECTED（回到意向产品）
router.put('/batch-rollback', async (req: Request, res: Response) => {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择至少一个产品' });
      return;
    }

    const productIds = ids.map(Number).filter((n) => !isNaN(n));

    const result = await prisma.product.updateMany({
      where: { id: { in: productIds }, status: 'PURCHASING', ownerId: req.user!.userId },
      data: {
        status:        'SELECTED',
        publishStatus: 'UNPUBLISHED',
      },
    });

    res.json({ code: 200, data: { count: result.count }, message: `已退回 ${result.count} 个产品至意向产品` });
  } catch (err) {
    console.error('[PUT /api/products/batch-rollback]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/batch-to-purchasing ──────────────────────
// 从库存 SKU 批量推送产品到采购计划（返单采购）
// body: { items: [{ id, purchasePrice, purchaseQuantity }, ...] }
// 已在采购计划中的产品执行数量累加，新产品直接推入
router.put('/batch-to-purchasing', async (req: Request, res: Response) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择产品' });
      return;
    }
    const userId = req.user!.userId;
    let count = 0;

    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const id = Number(item.id);
        if (isNaN(id)) continue;
        const qty   = Math.max(0, Number(item.purchaseQuantity) || 0);
        const price = item.purchasePrice != null ? Number(item.purchasePrice) : null;

        const product = await tx.product.findFirst({ where: { id, ownerId: userId, sku: { not: null } } });
        if (!product) continue;

        const isAlreadyPurchasing = product.status === 'PURCHASING';
        const newQty = isAlreadyPurchasing
          ? (product.purchaseQuantity ?? 0) + qty
          : qty;
        const finalPrice = price ?? (product.purchasePrice ? Number(product.purchasePrice) : null);

        await tx.product.update({
          where: { id },
          data: {
            status:           'PURCHASING',
            publishStatus:    'PUBLISHED',
            purchaseType:     'REPEAT',
            purchaseQuantity: newQty,
            ...(finalPrice != null ? { purchasePrice: finalPrice } : {}),
          },
        });
        count++;
      }
    });

    res.json({ code: 200, data: { count }, message: `已成功推送 ${count} 个产品至采购计划，重复产品已自动累加数量` });
  } catch (err) {
    console.error('[PUT /api/products/batch-to-purchasing]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/batch-stock-adjust ──────────────────────
// 批量调整库存：对选中产品统一增减 stockActual
router.put('/batch-stock-adjust', async (req: Request, res: Response) => {
  try {
    const { ids, delta } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择产品' });
      return;
    }
    const d = Number(delta);
    if (isNaN(d) || d === 0) {
      res.status(400).json({ code: 400, data: null, message: '调整数量不能为 0' });
      return;
    }
    const userId = req.user!.userId;
    let count = 0;
    await prisma.$transaction(async (tx) => {
      for (const id of ids) {
        const product = await tx.product.findFirst({ where: { id: Number(id), ownerId: userId } });
        if (!product) continue;
        const newStock = Math.max(0, product.stockActual + d);
        await tx.product.update({ where: { id: product.id }, data: { stockActual: newStock } });
        count++;
      }
    });
    res.json({ code: 200, data: { count }, message: `已调整 ${count} 个产品的库存` });
  } catch (err) {
    console.error('[PUT /api/products/batch-stock-adjust]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/batch-stock-set ─────────────────────────
// 批量库存盘点：直接覆盖设置每个产品的 stockActual
router.put('/batch-stock-set', async (req: Request, res: Response) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择产品' });
      return;
    }
    const userId = req.user!.userId;
    let count = 0;
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const id = Number(item.id);
        if (isNaN(id)) continue;
        const newStock = Math.max(0, Math.round(Number(item.stockActual) || 0));
        const result = await tx.product.updateMany({
          where: { id, ownerId: userId },
          data: { stockActual: newStock },
        });
        count += result.count;
      }
    });
    res.json({ code: 200, data: { count }, message: `已更新 ${count} 个产品的库存` });
  } catch (err) {
    console.error('[PUT /api/products/batch-stock-set]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── PUT /api/products/inventory-batch-update ──────────────────
// 库存 SKU 批量逐行编辑（中文名、物流规格、采购价等）
router.put('/inventory-batch-update', async (req: Request, res: Response) => {
  try {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '没有需要更新的数据' });
      return;
    }
    const userId = req.user!.userId;
    let count = 0;
    await prisma.$transaction(async (tx) => {
      for (const item of items) {
        const id = Number(item.id);
        if (isNaN(id)) continue;
        const data: Record<string, unknown> = {};
        if (item.chineseName   !== undefined) data.chineseName  = typeof item.chineseName === 'string' && item.chineseName.trim() ? item.chineseName.trim() : null;
        if (item.length        !== undefined) data.length       = item.length != null ? Number(item.length) : null;
        if (item.width         !== undefined) data.width        = item.width != null ? Number(item.width) : null;
        if (item.height        !== undefined) data.height       = item.height != null ? Number(item.height) : null;
        if (item.actualWeight  !== undefined) data.actualWeight = item.actualWeight != null ? Number(item.actualWeight) : null;
        if (item.purchasePrice !== undefined) data.purchasePrice = item.purchasePrice != null ? Number(item.purchasePrice) : null;
        if (Object.keys(data).length === 0) continue;
        const result = await tx.product.updateMany({ where: { id, ownerId: userId, sku: { not: null } }, data });
        count += result.count;
      }
    });
    res.json({ code: 200, data: { count }, message: `已更新 ${count} 个产品` });
  } catch (err) {
    console.error('[PUT /api/products/inventory-batch-update]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/products/inventory-create ───────────────────────
// 手动创建单个库存 SKU 产品
router.post('/inventory-create', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { sku, chineseName, purchasePrice, purchaseUrl, length: pLen, width: pWid, height: pHei, actualWeight, imageUrl } = req.body ?? {};
    if (!sku || typeof sku !== 'string' || !sku.trim()) {
      res.status(400).json({ code: 400, data: null, message: 'SKU 不能为空' });
      return;
    }
    const product = await prisma.product.create({
      data: {
        pnk:           `MAN-${Date.now()}`,
        title:         chineseName?.trim() || sku.trim(),
        sku:           sku.trim(),
        chineseName:   chineseName?.trim() || null,
        imageUrl:      imageUrl?.trim() || null,
        purchasePrice: purchasePrice != null ? Number(purchasePrice) : null,
        purchaseUrl:   purchaseUrl?.trim() || null,
        length:        pLen != null ? Number(pLen) : null,
        width:         pWid != null ? Number(pWid) : null,
        height:        pHei != null ? Number(pHei) : null,
        actualWeight:  actualWeight != null ? Number(actualWeight) : null,
        ownerId:       userId,
        status:        'SELECTED',
        publishStatus: 'UNPUBLISHED',
        developer:     (await prisma.user.findUnique({ where: { id: userId } }))?.name ?? req.user!.username,
      },
    });
    res.json({ code: 200, data: { id: product.id }, message: '创建成功' });
  } catch (err: unknown) {
    const prismaErr = err as { code?: string };
    if (prismaErr.code === 'P2002') {
      res.status(400).json({ code: 400, data: null, message: '该 SKU 已存在' });
      return;
    }
    console.error('[POST /api/products/inventory-create]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── POST /api/products/inventory-batch-create ─────────────────
// 批量创建库存 SKU 产品
router.post('/inventory-batch-create', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供产品数据' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const devName = user?.name ?? req.user!.username;
    let count = 0;
    const errors: string[] = [];
    for (const item of items) {
      const sku = item.sku?.trim();
      if (!sku) { errors.push('跳过空 SKU'); continue; }

      const purchaseUrl = item.purchaseUrl?.trim() || null;
      let externalProductId: string | null = null;
      if (purchaseUrl) {
        const m = purchaseUrl.match(/offer\/(\d+)/i) || purchaseUrl.match(/id=(\d+)/i) || purchaseUrl.match(/(\d{10,})/);
        if (m) externalProductId = m[1];
      }

      try {
        await prisma.product.create({
          data: {
            pnk:           `MAN-${Date.now()}-${count}`,
            title:         item.chineseName?.trim() || sku,
            sku,
            chineseName:   item.chineseName?.trim() || null,
            imageUrl:      item.imageUrl?.trim() || null,
            purchaseUrl,
            purchasePrice: item.purchasePrice != null ? Number(item.purchasePrice) : null,
            externalProductId,
            length:        item.length != null ? Number(item.length) : null,
            width:         item.width != null ? Number(item.width) : null,
            height:        item.height != null ? Number(item.height) : null,
            actualWeight:  item.actualWeight != null ? Number(item.actualWeight) : null,
            ownerId:       userId,
            status:        'SELECTED',
            publishStatus: 'UNPUBLISHED',
            developer:     devName,
          },
        });
        count++;
      } catch (e: unknown) {
        const pe = e as { code?: string };
        if (pe.code === 'P2002') errors.push(`SKU "${sku}" 已存在`);
        else throw e;
      }
    }
    const msg = errors.length > 0
      ? `成功创建 ${count} 个产品，${errors.length} 个跳过（${errors.slice(0, 3).join('；')}）`
      : `成功创建 ${count} 个产品`;
    res.json({ code: 200, data: { count, errors }, message: msg });
  } catch (err) {
    console.error('[POST /api/products/inventory-batch-create]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
});

// ── GET /api/products/inventory-export ────────────────────────
// 导出全局库存 SKU 数据（CSV 格式）
router.get('/inventory-export', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';
    const where: Record<string, unknown> = { ownerId: userId, sku: { not: null } };
    if (keyword) {
      (where as any).OR = [
        { sku: { contains: keyword, mode: 'insensitive' } },
        { chineseName: { contains: keyword, mode: 'insensitive' } },
      ];
    }
    const products = await prisma.product.findMany({ where: where as any, orderBy: { updatedAt: 'desc' } });
    const header = 'SKU,中文名,开发人员,采购价,采购链接,长(cm),宽(cm),高(cm),实重(kg),当前库存,在途库存,7天销量,14天销量,30天销量,状态';
    const rows = products.map((p) => [
      p.sku ?? '', (p.chineseName ?? '').replace(/,/g, '，'), p.developer ?? '',
      p.purchasePrice ? Number(p.purchasePrice).toFixed(2) : '',
      p.purchaseUrl ?? '',
      p.length ? Number(p.length) : '', p.width ? Number(p.width) : '', p.height ? Number(p.height) : '',
      p.actualWeight ? Number(p.actualWeight).toFixed(2) : '',
      p.stockActual, p.stockInTransit, p.sales7d, p.sales14d, p.sales30d,
      p.status,
    ].join(','));
    const csv = '\uFEFF' + [header, ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=inventory_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[GET /api/products/inventory-export]', err);
    res.status(500).json({ code: 500, data: null, message: '导出失败' });
  }
});

export default router;
