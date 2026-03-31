import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authenticate, requireSuperAdmin } from '../middleware/auth';
import { importPublicSeaFromDisk } from '../services/importPublicSea';
import { backfillProductUrls } from '../services/storeProductSync';

const router = Router();

// 所有产品接口必须登录
router.use(authenticate);

// ── POST /api/products/sync-urls ─────────────────────────────────
// 平台产品 product_url 全量补齐（store_products 表）
router.post('/sync-urls', async (_req: Request, res: Response) => {
  try {
    const result = await backfillProductUrls();
    const nullCount = await prisma.storeProduct.count({ where: { productUrl: null } });
    const total = await prisma.storeProduct.count();
    res.json({
      code: 200,
      data: {
        updated: result.updated,
        total: result.total,
        product_url_null_remaining: nullCount,
        product_url_filled: total - nullCount,
        total_products: total,
        errors: result.errors,
      },
      message: `已补齐 ${result.updated} 个 product_url，当前 null 剩余: ${nullCount}/${total}`,
    });
  } catch (err: any) {
    console.error('[POST /api/products/sync-urls]', err);
    res.status(500).json({ code: 500, data: null, message: err?.message ?? '服务器内部错误' });
  }
});

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
// 拉取意向产品池：
//   - 超级管理员（roleName 含 admin/超级管理员，或同时拥有 MANAGE_ACCOUNTS + MANAGE_ROLES）可查全员数据
//   - 普通员工只查自己的（ownerId = 当前用户）
router.get('/private', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    const user = req.user!;
    const roleNameLower = (user.roleName ?? '').toLowerCase();
    const isSuperAdmin =
      roleNameLower.includes('admin') ||
      roleNameLower.includes('超级管理员') ||
      user.permissions.includes('*') ||
      user.permissions.includes('ALL') ||
      user.permissions.includes('ADMIN_FULL') ||
      (user.permissions.includes('MANAGE_ACCOUNTS') && user.permissions.includes('MANAGE_ROLES'));

    // 意向产品定义：
    //   - status = SELECTED
    //   - pnk 不以 "MAN-" 开头（MAN- 是手动导入老 SKU 的虚构 pnk，直接进库存，不进意向池）
    //   - isDeleted = false
    // 注意：正常 eMAG 产品建库后（有 sku）依然留在意向池，直到 PURCHASING 才离开
    const where: Record<string, unknown> = {
      status:    'SELECTED' as const,
      isDeleted: false,
      NOT: { pnk: { startsWith: 'MAN-' } },  // ★ 排除手动导入的老记录
    };
    if (!isSuperAdmin) {
      where.ownerId = user.userId;  // 普通员工只能查看自己的意向产品
    }

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
        // ★ 进入采购计划时清空旧采购单关联，确保能出现在采购计划列表
        purchaseOrderId:  null,
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
// 采购计划列表：只显示 status=PURCHASING 且 purchaseOrderId=null 的产品
// 状态机说明：
//   PURCHASING + purchaseOrderId=null  → 在采购计划中（待建单）
//   ORDERED    + purchaseOrderId!=null → 已建采购单，进入采购管理，不在计划列表显示
router.get('/purchasing', async (req: Request, res: Response) => {
  try {
    const page     = Math.max(1, parseInt(String(req.query.page     ?? 1),  10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? 20), 10) || 20));
    const skip     = (page - 1) * pageSize;

    const user = req.user!;
    const roleNameLower = (user.roleName ?? '').toLowerCase();
    const isSuperAdmin =
      roleNameLower.includes('admin') ||
      roleNameLower.includes('超级管理员') ||
      user.permissions.includes('*') ||
      user.permissions.includes('ALL') ||
      user.permissions.includes('ADMIN_FULL') ||
      (user.permissions.includes('MANAGE_ACCOUNTS') && user.permissions.includes('MANAGE_ROLES'));

    // 超管拥有全局视角，不添加 ownerId 过滤，可查看所有子账号的采购计划
    // 普通员工只能查看自己（ownerId = 当前用户）推入的采购计划
    const where: Record<string, unknown> = {
      status:          'PURCHASING' as const,
      purchaseOrderId: null,
    };
    if (!isSuperAdmin) {
      where.ownerId = user.userId;
    }

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
// 库存 SKU 列表：查询所有已建库（sku 非空）的产品，全员可见全量数据
// 多仓兜底：每个产品的 warehouseStocks 数组长度 = 当前 ACTIVE 仓库总数，
//           缺失记录自动补 0 占位，保证前端展开按钮始终可见。
router.get('/inventory', async (req: Request, res: Response) => {
  try {
    const pageNum  = Math.max(1, Number(req.query.page)     || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const keyword  = typeof req.query.keyword === 'string' ? req.query.keyword.trim() : '';

    // ① 预查所有启用仓库（用于后续补齐 0 库存占位行）
    const activeWarehouses = await prisma.warehouse.findMany({
      where:   { status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      select:  { id: true, name: true, type: true },
    });

    // 库存 SKU 属于团队公共资源，不按 ownerId 过滤，全员可查全量；排除已软删除记录
    const where: Record<string, unknown> = { sku: { not: null }, isDeleted: false };

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
        include: {
          warehouseStocks: {
            include: { warehouse: { select: { id: true, name: true, type: true, status: true } } },
          },
        },
      }),
      prisma.product.count({ where: where as any }),
    ]);

    const list = products.map((p) => {
      // ② 多仓架构：总库存 = 各 ACTIVE 仓 stockQuantity 之和
      const activeStocks = (p.warehouseStocks ?? []).filter((ws) => ws.warehouse.status === 'ACTIVE');
      const totalStock = activeStocks.reduce((sum, ws) => sum + ws.stockQuantity, 0);

      // ③ 已有记录 map（key = warehouseId）
      const existingMap = new Map(
        (p.warehouseStocks ?? []).map((ws) => [ws.warehouseId, ws]),
      );

      // 产品基础采购价（unitCost 为 0 时的兜底默认成本）
      const basePurchasePrice = p.purchasePrice ? Number(p.purchasePrice) : 0;

      // ④ 补齐缺失仓库 → 确保每个 ACTIVE 仓库都有对应行（stockQuantity = 0）
      const fullWarehouseStocks = activeWarehouses.map((wh) => {
        const ws = existingMap.get(wh.id);
        if (ws) {
          return {
            id:                ws.id,
            warehouseId:       ws.warehouseId,
            warehouseName:     ws.warehouse.name,
            warehouseType:     ws.warehouse.type,
            stockQuantity:     ws.stockQuantity,
            lockedQuantity:    ws.lockedQuantity,
            inTransitQuantity: ws.inTransitQuantity,
            // unitCost 为 0（尚未录入运费公摊）时，降级使用产品基础采购价兜底
            unitCost:          ws.unitCost > 0 ? ws.unitCost : basePurchasePrice,
            sales7:            ws.sales7,
            sales14:           ws.sales14,
            sales30:           ws.sales30,
          };
        }
        // 该仓库无记录 → 0 库存占位行（id = null 前端可识别）
        return {
          id:                null,
          warehouseId:       wh.id,
          warehouseName:     wh.name,
          warehouseType:     wh.type,
          stockQuantity:     0,
          lockedQuantity:    0,
          inTransitQuantity: 0,
          unitCost:          basePurchasePrice,   // 无记录时直接用产品采购价作为起始成本
          sales7:            0,
          sales14:           0,
          sales30:           0,
        };
      });

      return {
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
        stockActual:    p.stockActual,                // 保留旧字段（向后兼容）
        stockTotal:     totalStock,                   // 多仓汇总库存（前端优先使用此值）
        stockInTransit: p.stockInTransit,
        sales7d:        p.sales7d,
        sales14d:       p.sales14d,
        sales30d:       p.sales30d,
        status:         p.status,
        publishStatus:  p.publishStatus,
        externalProductId: p.externalProductId ?? null,
        externalSkuId:     p.externalSkuId     ?? null,
        updatedAt:      p.updatedAt,
        warehouseStocks: fullWarehouseStocks,         // 已补齐，长度 = ACTIVE 仓库数
      };
    });

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

    const user = req.user!;
    const roleNameLower = (user.roleName ?? '').toLowerCase();
    const isSuperAdmin =
      roleNameLower.includes('admin') ||
      roleNameLower.includes('超级管理员') ||
      user.permissions.includes('*') ||
      user.permissions.includes('ALL') ||
      user.permissions.includes('ADMIN_FULL') ||
      (user.permissions.includes('MANAGE_ACCOUNTS') && user.permissions.includes('MANAGE_ROLES'));

    // ★ 铁律防线：purchaseOrderId: null 确保绝不碰已建单产品
    // 超管可退回任何人的计划条目，普通员工只能退自己的
    const whereCondition: Record<string, unknown> = {
      id:              { in: productIds },
      status:          'PURCHASING',
      purchaseOrderId: null,
    };
    if (!isSuperAdmin) {
      whereCondition.ownerId = user.userId;
    }

    const result = await prisma.product.updateMany({
      where: whereCondition as any,
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

// ── POST /api/products/batch-discard  (前端调用)
// ── PUT  /api/products/batch-discard  (兼容旧调用)
// 从采购计划移除产品 —— 仅做状态退回，绝对禁止物理删除 Product 记录
// Product 是主数据（Master Data），只有超管在【库存SKU】页面才可删除
// body: { ids: number[] }
async function batchDiscardHandler(req: Request, res: Response): Promise<void> {
  try {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请选择至少一个产品' });
      return;
    }

    const productIds = ids.map(Number).filter((n) => !isNaN(n) && n > 0);
    if (productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
      return;
    }

    const user = req.user!;
    const userId = user.userId;
    const roleNameLower = (user.roleName ?? '').toLowerCase();
    const isSuperAdmin =
      roleNameLower.includes('admin') ||
      roleNameLower.includes('超级管理员') ||
      user.permissions.includes('*') ||
      user.permissions.includes('ALL') ||
      user.permissions.includes('ADMIN_FULL') ||
      (user.permissions.includes('MANAGE_ACCOUNTS') && user.permissions.includes('MANAGE_ROLES'));

    // ★ 铁律防线：purchaseOrderId: null 是绝对硬卡，确保永远不会误清已建单产品的关联关系
    // 超管可操作全公司所有计划条目，普通员工只能操作自己的
    const whereCondition: Record<string, unknown> = {
      id:              { in: productIds },
      status:          'PURCHASING',
      purchaseOrderId: null,
    };
    if (!isSuperAdmin) {
      whereCondition.ownerId = userId;
    }

    const result = await prisma.product.updateMany({
      where: whereCondition as any,
      data: {
        // 退回意向产品池（SELECTED），清空采购计划暂存数据
        status:           'SELECTED',
        publishStatus:    'UNPUBLISHED',
        purchaseQuantity: null,
        purchasePeriod:   null,
        purchaseType:     null,
        purchaseOrderId:  null,
      },
    });

    console.log(`[batch-discard] userId=${userId} isSuperAdmin=${isSuperAdmin} 移出计划 ${result.count} 个产品（状态退回 SELECTED）`);
    res.json({
      code:    200,
      data:    { count: result.count },
      message: `已将 ${result.count} 个产品从采购计划移出`,
    });
  } catch (err) {
    console.error('[batch-discard]', err);
    res.status(500).json({ code: 500, data: null, message: '服务器内部错误' });
  }
}

// 同时注册 POST（前端实际调用）和 PUT（保留兼容）
router.post('/batch-discard', batchDiscardHandler);
router.put('/batch-discard', batchDiscardHandler);

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

        // 库存 SKU 是公司共有资产，不按 ownerId 过滤；
        // 任何员工都可以将任意 SKU 推入自己的采购计划
        const product = await tx.product.findFirst({ where: { id, sku: { not: null }, isDeleted: false } });
        if (!product) continue;

        const isAlreadyPurchasing = product.status === 'PURCHASING' && product.ownerId === userId;
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
            // ★ 必须设置 ownerId 为当前操作人，确保查询接口能按操作人过滤到此条记录
            ownerId:          userId,
            // ★ 必须清空 purchaseOrderId：产品重新进入采购计划意味着
            //   它脱离了上一个采购单，purchaseOrderId: null 才能出现在
            //   GET /api/products/purchasing 的采购计划列表中
            purchaseOrderId:  null,
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
// 批量创建库存 SKU 产品（鉴权由顶层 router.use(authenticate) 保证）
router.post('/inventory-batch-create', async (req: Request, res: Response) => {
  try {
    // ① 鉴权防守：authenticate 中间件已挂载，此处做二次兜底
    const userId = req.user?.userId;
    if (!userId || typeof userId !== 'number') {
      res.status(401).json({ code: 401, data: null, message: '未登录或登录已过期，请重新登录' });
      return;
    }

    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供产品数据（items 不能为空）' });
      return;
    }

    // 查询操作人姓名（用于 developer 字段）
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
            pnk:              `MAN-${Date.now()}-${count}`,
            title:            item.chineseName?.trim() || sku,
            sku,
            chineseName:      item.chineseName?.trim() || null,
            imageUrl:         item.imageUrl?.trim() || null,
            purchaseUrl,
            purchasePrice:    item.purchasePrice != null ? Number(item.purchasePrice) : null,
            externalProductId,
            length:           item.length != null ? Number(item.length) : null,
            width:            item.width != null ? Number(item.width) : null,
            height:           item.height != null ? Number(item.height) : null,
            actualWeight:     item.actualWeight != null ? Number(item.actualWeight) : null,
            ownerId:          userId,   // 已在上方确认为有效 number
            status:           'SELECTED',
            publishStatus:    'UNPUBLISHED',
            developer:        devName,
          },
        });
        count++;
      } catch (e: unknown) {
        const pe = e as { code?: string; message?: string; name?: string };

        if (pe.code === 'P2002') {
          // 唯一约束冲突（SKU 重复）
          errors.push(`SKU "${sku}" 已存在`);
        } else if (pe.name === 'PrismaClientValidationError') {
          // ② Prisma 参数校验失败：记录错误，绝不让进程崩溃
          const detail = pe.message?.split('\n').slice(0, 2).join(' ') ?? '数据格式错误';
          console.error(`[inventory-batch-create] SKU "${sku}" Prisma 校验失败:`, detail);
          errors.push(`SKU "${sku}" 数据格式错误：${detail.slice(0, 80)}`);
        } else {
          // ③ 其他未知错误：记录日志，继续处理下一条，不中断整批
          console.error(`[inventory-batch-create] SKU "${sku}" 未知错误:`, e);
          errors.push(`SKU "${sku}" 写入失败（未知错误）`);
        }
      }
    }

    const msg = errors.length > 0
      ? `成功创建 ${count} 个产品，${errors.length} 条跳过（${errors.slice(0, 3).join('；')}）`
      : `成功创建 ${count} 个产品`;
    res.json({ code: 200, data: { count, errors }, message: msg });

  } catch (err) {
    // 外层 catch：仅捕获查询 userId/devName 时的意外异常，返回 400 而非让进程崩溃
    console.error('[POST /api/products/inventory-batch-create]', err);
    const msg = err instanceof Error ? err.message : '服务器内部错误';
    res.status(400).json({ code: 400, data: null, message: msg });
  }
});

// ── DELETE /api/products/inventory ────────────────────────────
// 批量强制删除库存 SKU（仅超级管理员可执行）
// Body: { ids: number[] }
// 级联清理顺序（事务内）：
//   1. InventoryLog       — 流水记录
//   2. FbeShipmentItem    — FBE 发货明细（若产品在 SHIPPED 中的发货单则拒绝删除）
//   3. WarehouseStock     — 多仓库存明细
//   4. Product (主表)     — 物理删除
router.delete('/inventory', requireSuperAdmin, async (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids: unknown };

    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ code: 400, data: null, message: 'ids 必须为非空数组' });
      return;
    }

    const productIds: number[] = ids
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v > 0);

    if (productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: 'ids 中没有有效的产品 ID' });
      return;
    }

    // ── 安全预检：拒绝删除仍在 SHIPPED（已发货/在途）FBE 发货单中的产品 ──
    const activeShipmentItems = await prisma.fbeShipmentItem.findMany({
      where: {
        productId: { in: productIds },
        shipment:  { status: { in: ['SHIPPED'] } },
      },
      select: { productId: true, shipment: { select: { shipmentNumber: true } } },
    });
    if (activeShipmentItems.length > 0) {
      const blocked = activeShipmentItems.map(
        (si) => `产品ID ${si.productId}（发货单 ${si.shipment.shipmentNumber}）`,
      );
      res.status(409).json({
        code: 409,
        data: null,
        message: `以下产品仍在运输中，无法删除：${blocked.join('；')}`,
      });
      return;
    }

    // ── 事务级联删除 ───────────────────────────────────────────────
    let deletedCount = 0;
    await prisma.$transaction(async (tx) => {
      // 1. 库存流水
      await tx.inventoryLog.deleteMany({ where: { productId: { in: productIds } } });

      // 2. FBE 发货明细（非 SHIPPED 状态，如 PENDING/ALLOCATING/ARRIVED/CANCELLED）
      await tx.fbeShipmentItem.deleteMany({ where: { productId: { in: productIds } } });

      // 3. 多仓库存明细
      await tx.warehouseStock.deleteMany({ where: { productId: { in: productIds } } });

      // 4. 主表物理删除（忽略软删除标记，强制清除）
      const result = await tx.product.deleteMany({ where: { id: { in: productIds } } });
      deletedCount = result.count;
    });

    console.log(`[批量删除SKU] 操作者=${req.user!.username}，删除 ${deletedCount} 条产品，ids=[${productIds.join(',')}]`);

    res.json({
      code: 200,
      data: { deletedCount, requestedCount: productIds.length },
      message: `已成功删除 ${deletedCount} 个 SKU 及其全部关联数据`,
    });
  } catch (err: unknown) {
    console.error('[DELETE /api/products/inventory]', err);
    res.status(500).json({ code: 500, data: null, message: '批量删除失败，请检查数据关联' });
  }
});

// ── DELETE /api/products/inventory/:id ────────────────────────
// 智能混合删除：优先物理删除；若有关联业务数据（FK 约束 P2003），降级为软删除归档
// 无论哪种结果，均返回 200，绝不导致进程崩溃或返回 503
router.delete('/inventory/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id) || id <= 0) {
    res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
    return;
  }

  try {
    // ① 前置校验：产品必须存在且为库存 SKU（sku 非空）
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }
    if (!product.sku) {
      res.status(400).json({ code: 400, data: null, message: '该产品不是库存 SKU，无法从此接口删除' });
      return;
    }
    if (product.isDeleted) {
      res.status(400).json({ code: 400, data: null, message: '该产品已被归档删除' });
      return;
    }

    // ② 尝试物理删除
    try {
      await prisma.product.delete({ where: { id } });
      console.log(`[inventory-delete] 产品 id=${id} SKU=${product.sku} 已物理删除`);
      res.json({
        code: 200,
        data: { id, sku: product.sku, deleteType: 'hard' },
        message: `SKU「${product.sku}」已彻底删除`,
      });
      return;
    } catch (delErr: unknown) {
      const pe = delErr as { code?: string };

      // ③ 有关联数据（FK 约束）→ 静默降级为软删除
      if (pe.code === 'P2003' || pe.code === 'P2014') {
        await prisma.product.update({
          where: { id },
          data: { isDeleted: true },
        });
        console.log(`[inventory-delete] 产品 id=${id} SKU=${product.sku} 有关联数据，已软删除归档 (${pe.code})`);
        res.json({
          code: 200,
          data: { id, sku: product.sku, deleteType: 'soft' },
          message: `SKU「${product.sku}」存在关联业务数据，已安全归档（不影响历史记录）`,
        });
        return;
      }

      // ④ 其他未知错误：记录日志，返回 400，绝不崩溃
      console.error(`[inventory-delete] 产品 id=${id} 删除失败:`, delErr);
      const msg = delErr instanceof Error ? delErr.message : '删除失败，请稍后重试';
      res.status(400).json({ code: 400, data: null, message: msg });
    }
  } catch (err) {
    console.error('[DELETE /api/products/inventory/:id]', err);
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

// ── PATCH /api/products/:id/quick-map ────────────────────────
// 快捷单点更新产品的 1688 规格 specId（下单弹窗内联选规格后立即补全映射）
//
// Body: { externalSkuId: string (32位MD5), externalSkuIdNum?: string }
// ──────────────────────────────────────────────────────────────
router.patch('/:id/quick-map', async (req: Request, res: Response) => {
  try {
    const productId = parseInt(String(req.params.id), 10);
    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
      return;
    }

    const { externalSkuId, externalSkuIdNum } = req.body ?? {};

    if (!externalSkuId || typeof externalSkuId !== 'string' || !externalSkuId.trim()) {
      res.status(400).json({ code: 400, data: null, message: '缺少 externalSkuId（32位MD5 specId）' });
      return;
    }

    const cleanSpecId = externalSkuId.trim();
    if (!/^[a-fA-F0-9]{32}$/.test(cleanSpecId)) {
      res.status(400).json({
        code: 400, data: null,
        message: `externalSkuId 必须是 32 位十六进制 MD5 字符串，收到 "${cleanSpecId.slice(0, 20)}..." (len=${cleanSpecId.length})`,
      });
      return;
    }

    const product = await prisma.product.findUnique({
      where:  { id: productId },
      select: { id: true, sku: true, externalProductId: true, externalSkuId: true },
    });
    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不存在' });
      return;
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data: {
        externalSkuId:    cleanSpecId,
        externalSkuIdNum: externalSkuIdNum ? String(externalSkuIdNum).trim() : undefined,
        externalSynced:   true,   // 标记已完成 1688 映射，下单校验可通过
      },
      select: {
        id: true, sku: true,
        externalProductId: true, externalSkuId: true,
        externalSkuIdNum: true, externalSynced: true,
      },
    });

    console.log(
      `[quick-map] 产品 #${productId}(${product.sku ?? 'no-sku'}) specId 已更新：` +
      `${product.externalSkuId?.slice(0, 8) ?? 'null'} → ${cleanSpecId.slice(0, 8)}...`,
    );

    res.json({
      code: 200,
      data: updated,
      message: `规格映射已更新 (specId: ${cleanSpecId.slice(0, 8)}...)`,
    });
  } catch (err: any) {
    console.error('[PATCH /api/products/:id/quick-map]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新规格映射失败' });
  }
});

// ── POST /api/products/remove-from-plan ───────────────────────────────────
// 从采购计划移除产品（只操作计划中的产品，即 status=PURCHASING + purchaseOrderId=null）
// 仅做状态退回，绝对禁止物理删除 Product 主数据
// body: { productIds: number[] }
// ──────────────────────────────────────────────────────────────────────────
router.post('/remove-from-plan', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { productIds } = req.body ?? {};

    if (!Array.isArray(productIds) || productIds.length === 0) {
      res.status(400).json({ code: 400, data: null, message: '请提供 productIds 数组' });
      return;
    }

    const ids = productIds.map(Number).filter((n) => !isNaN(n) && n > 0);
    if (ids.length === 0) {
      res.status(400).json({ code: 400, data: null, message: 'productIds 无效' });
      return;
    }

    // 仅操作「计划中」的产品：status=PURCHASING + purchaseOrderId=null + 属于当前用户
    const result = await prisma.product.updateMany({
      where: {
        id:              { in: ids },
        status:          'PURCHASING',
        purchaseOrderId: null,
        ownerId:         userId,
      },
      data: {
        status:           'SELECTED',
        publishStatus:    'UNPUBLISHED',
        purchaseQuantity: null,
        purchasePeriod:   null,
        purchaseType:     null,
        purchaseOrderId:  null,
      },
    });

    if (result.count === 0) {
      res.json({ code: 200, data: { count: 0 }, message: '没有可移除的计划产品（可能已建单或不属于当前用户）' });
      return;
    }

    console.log(`[remove-from-plan] userId=${userId} 移出计划 ${result.count} 个产品（状态退回 SELECTED）`);
    res.json({ code: 200, data: { count: result.count }, message: `已将 ${result.count} 个产品从采购计划移出` });
  } catch (err: any) {
    console.error('[POST /api/products/remove-from-plan]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '移除计划产品失败' });
  }
});

// ── PATCH /api/products/:id/plan-quantity ─────────────────────────────────
// 修改采购计划中单个产品的预定采购数量（只允许修改尚未建单的计划产品）
// body: { quantity: number }
// ──────────────────────────────────────────────────────────────────────────
router.patch('/:id/plan-quantity', async (req: Request, res: Response) => {
  try {
    const userId    = req.user!.userId;
    const productId = parseInt(String(req.params.id), 10);

    if (isNaN(productId) || productId <= 0) {
      res.status(400).json({ code: 400, data: null, message: '产品 ID 无效' });
      return;
    }

    const qty = parseInt(String(req.body?.quantity ?? req.body?.purchaseQuantity), 10);
    if (isNaN(qty) || qty < 1) {
      res.status(400).json({ code: 400, data: null, message: '采购数量必须 ≥ 1' });
      return;
    }

    // 安全校验：只允许修改「计划中」的产品（status=PURCHASING + purchaseOrderId=null + 属于当前用户）
    const product = await prisma.product.findFirst({
      where: {
        id:              productId,
        status:          'PURCHASING',
        purchaseOrderId: null,
        ownerId:         userId,
      },
      select: { id: true, sku: true, purchaseQuantity: true },
    });

    if (!product) {
      res.status(404).json({ code: 404, data: null, message: '产品不在采购计划中，或已建单无法修改数量' });
      return;
    }

    const updated = await prisma.product.update({
      where: { id: productId },
      data:  { purchaseQuantity: qty },
      select: { id: true, sku: true, purchaseQuantity: true },
    });

    console.log(`[plan-quantity] 产品 #${productId}(${product.sku ?? '-'}) 采购数量 ${product.purchaseQuantity ?? 0} → ${qty}`);
    res.json({ code: 200, data: updated, message: `采购数量已更新为 ${qty}` });
  } catch (err: any) {
    console.error('[PATCH /api/products/:id/plan-quantity]', err?.message ?? err);
    res.status(500).json({ code: 500, data: null, message: '更新采购数量失败' });
  }
});

export default router;
