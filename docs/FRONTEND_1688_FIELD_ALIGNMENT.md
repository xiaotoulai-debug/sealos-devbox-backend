# 前端 1688 字段对齐说明（erp-frontend 必读）

## 1. 采购单明细表格字段

后端已统一使用 `externalOrderId` 作为 1688 订单号的主字段名。

**必须修改**：采购单明细表格（展开子表）中「1688 订单号」列的 `dataIndex`：

```diff
- dataIndex: 'alibabaOrderId'
+ dataIndex: 'externalOrderId'
```

## 2. API 返回字段

| 字段 | 说明 | 来源 |
|------|------|------|
| `externalOrderId` | 1688 订单号（5100... 开头） | 主字段，优先使用 |
| `alibabaOrderId` | 同上（兼容） | 与 externalOrderId 等价 |
| `alibabaOrderStatus` | 订单状态 | waitbuyerpay / waitsellersend / success |
| `alibabaTotalAmount` | 总金额（含运费） | 元 |
| `shippingFee` | 运费 | 元 |

## 3. 同步接口传参

调用 `POST /api/procurement/sync-1688-order` 时，请传：

```json
{
  "externalOrderId": "5100..."
}
```

或 `purchaseOrderItemId`。

## 4. 修改后效果

修改 `dataIndex` 为 `externalOrderId` 后，页面将能正确显示 5100 开头的 1688 单号。
