import { prisma } from '../src/lib/prisma';

type DuplicateRow = {
  id: number;
  shop_id: number;
  pnk: string;
  sku: string | null;
  vendor_sku: string | null;
  ean: string | null;
  emag_offer_id: string | null;
  mapped_inventory_sku: string | null;
  synced_at: Date;
};

const shouldFix = process.argv.includes('--fix');

function normalizeBusinessKey(value: string | null | undefined): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

function hasMappedInventorySku(row: DuplicateRow): boolean {
  return Boolean(row.mapped_inventory_sku?.trim());
}

function offerRank(row: DuplicateRow): number {
  const raw = row.emag_offer_id?.trim();
  if (!raw) return Number.NEGATIVE_INFINITY;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric;
  return raw
    .split('')
    .reduce((sum, ch, index) => sum + ch.charCodeAt(0) * (index + 1), 0);
}

function pickWinner(rows: DuplicateRow[]): DuplicateRow {
  return [...rows].sort((a, b) => {
    const mappedDiff = Number(hasMappedInventorySku(b)) - Number(hasMappedInventorySku(a));
    if (mappedDiff !== 0) return mappedDiff;

    const syncedDiff = new Date(b.synced_at).getTime() - new Date(a.synced_at).getTime();
    if (syncedDiff !== 0) return syncedDiff;

    const offerDiff = offerRank(b) - offerRank(a);
    if (offerDiff !== 0) return offerDiff;

    return b.id - a.id;
  })[0];
}

async function main() {
  const rows = await prisma.$queryRawUnsafe<DuplicateRow[]>(`
    SELECT
      id,
      shop_id,
      pnk,
      sku,
      vendor_sku,
      ean,
      emag_offer_id,
      mapped_inventory_sku,
      synced_at
    FROM store_products
    WHERE COALESCE(
      NULLIF(TRIM(ean), ''),
      NULLIF(TRIM(vendor_sku), ''),
      NULLIF(TRIM(sku), ''),
      NULLIF(TRIM(emag_offer_id), '')
    ) IS NOT NULL
    ORDER BY shop_id, id
  `);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const parent = new Map<number, number>();
  for (const row of rows) parent.set(row.id, row.id);

  const find = (id: number): number => {
    const p = parent.get(id);
    if (p === undefined || p === id) return id;
    const root = find(p);
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const identityBuckets = new Map<string, number[]>();
  for (const row of rows) {
    const identities = [
      ['ean', row.ean],
      ['vendorSku', row.vendor_sku],
      ['sku', row.sku],
      ['offer', row.emag_offer_id],
    ] as const;
    for (const [kind, value] of identities) {
      const key = normalizeBusinessKey(value);
      if (!key) continue;
      const bucketKey = `${row.shop_id}:${kind}:${key.toLowerCase()}`;
      const bucket = identityBuckets.get(bucketKey) ?? [];
      bucket.push(row.id);
      identityBuckets.set(bucketKey, bucket);
    }
  }

  for (const ids of identityBuckets.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
  }

  const components = new Map<number, DuplicateRow[]>();
  for (const row of rows) {
    const root = find(row.id);
    const component = components.get(root) ?? [];
    component.push(row);
    components.set(root, component);
  }

  const duplicateComponents = [...components.values()].filter((component) => component.length > 1);
  const loserIds: number[] = [];
  for (const component of duplicateComponents) {
    const rows = component;
    const winner = pickWinner(rows);
    const losers = rows.filter((row) => row.id !== winner.id);
    loserIds.push(...losers.map((row) => row.id));

    console.log(
      `[StoreProduct Dedup] shop=${winner.shop_id} keep=${winner.id}` +
      ` keys=${[
        winner.ean ? `ean:${winner.ean}` : null,
        winner.vendor_sku ? `vendor:${winner.vendor_sku}` : null,
        winner.sku ? `sku:${winner.sku}` : null,
        winner.emag_offer_id ? `offer:${winner.emag_offer_id}` : null,
      ].filter(Boolean).join('|')}` +
      ` losers=${losers.map((row) => row.id).join(',')}`,
    );
  }

  console.log(
    `[StoreProduct Dedup] duplicateGroups=${duplicateComponents.length}, losers=${loserIds.length}, scanned=${byId.size}, mode=${shouldFix ? 'FIX' : 'DRY_RUN'}`,
  );

  if (shouldFix && loserIds.length > 0) {
    const deleted = await prisma.storeProduct.deleteMany({
      where: { id: { in: loserIds } },
    });
    console.log(`[StoreProduct Dedup] hard deleted ${deleted.count} stale rows`);
  }
}

main()
  .catch((err) => {
    console.error('[StoreProduct Dedup] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
