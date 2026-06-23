# 1688 规格绑定 API 契约（前端必读）

## 问题现象

解析接口已正确返回 32 位 `specId`，但下单时仍提示「找不到 32 位 MD5 的 specId」——**根本原因是绑定接口未收到或未保存 `specId`**。

## 绑定接口

- **路径**: `PUT /api/alibaba/bind` 或 `PUT /api/procurement/bind`（别名）
- **认证**: 需要 JWT（`Authorization: Bearer <token>`）

## 请求体（必传字段）

```json
{
  "productId": 123,
  "offerId": "610947572360",
  "specId": "a1b2c3d4e5f6789012345678901234ab",
  "skuId": "6203938798759"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `productId` | number | ✅ | 系统产品 ID |
| `offerId` | string | ✅ | 1688 商品 ID（解析接口返回的 `offerId`） |
| `specId` | string | ✅ | **32 位 MD5 哈希**，解析接口 `specs[].specId`，**不可省略！** |
| `skuId` | string | 建议 | 1688 规格数字 ID，解析接口 `specs[].skuId` |

## 前端正确写法示例

解析接口 `POST /api/alibaba/parse-link` 返回：

```json
{
  "data": {
    "offerId": "610947572360",
    "specs": [
      {
        "skuId": "6203938798759",
        "specId": "a1b2c3d4e5f6789012345678901234ab",
        "specName": "颜色:红色;尺码:M",
        "price": 29.9,
        "stock": 100
      }
    ]
  }
}
```

用户选择某个规格后，点击「确认绑定」时，**必须**把该规格的 `specId` 和 `skuId` 一起传给绑定接口：

```typescript
// 用户选中的规格
const selectedSpec = specs.find(s => s.skuId === selectedSkuId) ?? specs[0];

await fetch('/api/alibaba/bind', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({
    productId,
    offerId: parseResult.offerId,
    specId: selectedSpec.specId,   // ★ 必须传！否则下单失败
    skuId: selectedSpec.skuId,
  }),
});
```

## 常见错误

1. **只传了 `skuId`，没传 `specId`** → 后端会返回 400，提示缺少 specId
2. **传了 `specId` 但值为数字**（如 `6203938798759`）→ 不是 32 位哈希，后端会返回 400
3. **`specId` 来自错误字段**（如 `skuId`）→ 必须用解析接口返回的 `specs[].specId`

## 后端校验逻辑（v1.2+）

- 若 `specId` 缺失或非字符串 → 400
- 若 `specId` 不符合 `/^[a-fA-F0-9]{32}$/` → 400，并返回当前收到的值便于排查
