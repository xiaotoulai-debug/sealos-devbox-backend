-- ============================================================
-- 在途库存校准脚本 (In-Transit Inventory Calibration)
-- 适用场景：采购单被删除但在途库存未回滚，导致幽灵库存
-- 唯一真相源：purchase_orders 中 status IN (PENDING/PLACED/IN_TRANSIT/PARTIAL) 的子单 quantity
-- 执行方式：在 Sealos PostgreSQL 控制台或 psql 中粘贴执行
-- ⚠️  请务必先执行【步骤 0 预检】，确认差异无误后再执行后续步骤
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 步骤 0：预检 ── 查看将被修正的差异（只读，安全执行）
-- ─────────────────────────────────────────────────────────────
WITH real_transit AS (
  SELECT
    pid::int                AS product_id,
    SUM(poi.quantity)       AS real_qty
  FROM purchase_order_items poi
  JOIN purchase_orders po ON poi.purchase_order_id = po.id,
       jsonb_array_elements_text(poi.product_ids::jsonb) AS pid
  WHERE po.status IN ('PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL')
    AND poi.product_ids IS NOT NULL
    AND poi.product_ids <> '[]'
  GROUP BY pid
)
SELECT
  ws.product_id,
  p.sku                                             AS sku,
  ws.warehouse_id,
  ws.in_transit_quantity                            AS "当前值(含脏数据)",
  COALESCE(rt.real_qty, 0)                          AS "校准真实值",
  ws.in_transit_quantity - COALESCE(rt.real_qty, 0) AS "差值(正数=幽灵库存)"
FROM warehouse_stocks ws
LEFT JOIN products p  ON p.id  = ws.product_id
LEFT JOIN real_transit rt ON rt.product_id = ws.product_id
WHERE ws.in_transit_quantity <> COALESCE(rt.real_qty, 0)
ORDER BY "差值(正数=幽灵库存)" DESC;


-- ─────────────────────────────────────────────────────────────
-- 步骤 1 + 2：在事务内执行全量校准（确认预检结果后再运行）
-- ─────────────────────────────────────────────────────────────
BEGIN;

-- 【CTE】计算每个产品真实的在途量（只统计未完成订单）
WITH real_transit AS (
  SELECT
    pid::int                AS product_id,
    SUM(poi.quantity)       AS real_qty
  FROM purchase_order_items poi
  JOIN purchase_orders po ON poi.purchase_order_id = po.id,
       jsonb_array_elements_text(poi.product_ids::jsonb) AS pid
  WHERE po.status IN ('PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL')
    AND poi.product_ids IS NOT NULL
    AND poi.product_ids <> '[]'
  GROUP BY pid
)

-- 步骤 1：有关联未完成订单的产品 → 精准覆写为真实值
UPDATE warehouse_stocks ws
SET
  in_transit_quantity = rt.real_qty,
  updated_at          = NOW()
FROM real_transit rt
WHERE rt.product_id = ws.product_id
  AND ws.in_transit_quantity <> rt.real_qty;

-- 步骤 2：无任何关联未完成订单但 in_transit_quantity > 0 → 直接清零（幽灵记录）
UPDATE warehouse_stocks
SET
  in_transit_quantity = 0,
  updated_at          = NOW()
WHERE in_transit_quantity > 0
  AND product_id NOT IN (
    SELECT DISTINCT pid::int
    FROM purchase_order_items poi
    JOIN purchase_orders po ON poi.purchase_order_id = po.id,
         jsonb_array_elements_text(poi.product_ids::jsonb) AS pid
    WHERE po.status IN ('PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL')
      AND poi.product_ids IS NOT NULL
      AND poi.product_ids <> '[]'
  );

-- 校准后复核：应返回 0 行（若有行说明还有异常，请勿 COMMIT，先 ROLLBACK 排查）
SELECT COUNT(*) AS "校准后仍有差异的行数(应为0)"
FROM warehouse_stocks ws
LEFT JOIN (
  SELECT
    pid::int          AS product_id,
    SUM(poi.quantity) AS real_qty
  FROM purchase_order_items poi
  JOIN purchase_orders po ON poi.purchase_order_id = po.id,
       jsonb_array_elements_text(poi.product_ids::jsonb) AS pid
  WHERE po.status IN ('PENDING', 'PLACED', 'IN_TRANSIT', 'PARTIAL')
    AND poi.product_ids IS NOT NULL
    AND poi.product_ids <> '[]'
  GROUP BY pid
) rt ON rt.product_id = ws.product_id
WHERE ws.in_transit_quantity <> COALESCE(rt.real_qty, 0);

-- 确认复核结果为 0 后，执行提交；否则执行 ROLLBACK;
COMMIT;
-- ROLLBACK;  ← 如果复核有异常行，注释掉 COMMIT 改用这行
