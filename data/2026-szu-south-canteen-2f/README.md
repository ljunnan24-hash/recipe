# 2026年深圳大学南区二楼食堂菜谱

这是从 Recipe 项目所用 Supabase 数据库中整理出的开放菜谱数据集。

- 菜品来源：深圳大学南区二楼食堂菜单
- 原始表：`public.restaurant_menu`
- 导出日期：2026年8月28日
- 数据规模：185 条菜品、6 个字段
- 图片：不包含
- 个人数据：不包含
- 数据许可：[CC BY 4.0](./LICENSE.md)

> 本数据集是个人项目对食堂菜单的整理，非深圳大学官方发布或维护。价格和供应情况可能随时间变化，请以食堂现场菜单为准；`calories` 与 `remark` 是项目数据库中的估算与整理字段，仅供参考，不应视为食堂官方营养检测结果或医疗建议。

## 文件

| 文件 | 用途 |
|---|---|
| [`menu.csv`](./menu.csv) | 通用表格格式，可用 Excel、Numbers、Python、R 等直接读取 |
| [`menu.json`](./menu.json) | 适合网页、JavaScript 和 API 使用 |
| [`menu.sql`](./menu.sql) | 可重复执行的 PostgreSQL / Supabase 导入脚本 |
| [`metadata.json`](./metadata.json) | 数据集名称、来源、日期、规模、分类统计与许可证等元数据 |
| [`LICENSE.md`](./LICENSE.md) | 数据许可与推荐署名方式 |

所有文本文件均为 UTF-8 编码。

## 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | integer | 原始表中的菜品主键 |
| `dish_name` | string | 菜品名称 |
| `category` | string | 菜品所在窗口或菜单分类 |
| `calories` | integer | 项目数据库中的估算热量，单位为 kcal |
| `price` | number | 菜单价格，单位为人民币元 |
| `remark` | string / null | 项目整理的食材或烹饪方式备注 |

## 分类统计

| 分类 | 菜品数 |
|---|---:|
| 6元小炒 | 10 |
| 7-8元档 | 8 |
| 煲仔菜 | 5 |
| 肠粉早餐 | 1 |
| 抄手/水饺 | 6 |
| 川湘菜 | 17 |
| 大碗面/粉 | 5 |
| 大众蛋类 | 3 |
| 大众豆制品 | 3 |
| 大众肉片 | 4 |
| 大众素食 | 20 |
| 风味晚餐 | 30 |
| 基础早餐 | 15 |
| 教师窗口 | 22 |
| 烧腊套餐 | 4 |
| 特色小炒 | 10 |
| 晚餐糖水 | 3 |
| 现炒粉面 | 10 |
| 炸酱盖浇面 | 9 |

## 快速使用

### Python（pandas）

```python
import pandas as pd

menu = pd.read_csv("data/2026-szu-south-canteen-2f/menu.csv")
print(menu.head())
```

### JavaScript / TypeScript

```js
import menu from "./data/2026-szu-south-canteen-2f/menu.json" with { type: "json" };

console.log(menu.length);
```

### PostgreSQL / Supabase

在 SQL Editor 或 `psql` 中执行：

```bash
psql "$DATABASE_URL" -f data/2026-szu-south-canteen-2f/menu.sql
```

脚本会创建 `public.szu_south_canteen_menu_2026`，并按 `id` 幂等写入 185 条记录。它不会修改原始 `restaurant_menu` 表。

## 数据完整性

导出时已检查：

- 185 条记录，`id` 均唯一；
- 菜名、分类、热量和价格均无缺失；
- 热量和价格均无负数；
- 未导出 `auth.users`、用户档案、饮食记录、健康报告、API 密钥或其他敏感信息。

## 署名建议

使用或再分发时，建议标注：

> 数据：ljunnan24-hash，《2026年深圳大学南区二楼食堂菜谱》（菜品来源：深圳大学南区二楼食堂菜单），CC BY 4.0。

如发现菜单内容有误或发生变化，欢迎通过仓库 Issue 反馈。


