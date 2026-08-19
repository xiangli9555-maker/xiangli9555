# DFAI AI API 接口文档

> 导出时间：2026/7/17 16:14:51  
> 包含 1 个接口

---

## 🔵 L2 内部

### `GET` /aiapi/get_story

**TAPD 需求列表**

AI 专用需求列表查询（复用 getRedisStories），返回符合条件的 story。支持按 release / iteration / 日期 / 类型 / 状态 / 名称等过滤，并额外支持 area / smallteam（注意映射：area → custom_field_47，smallteam → custom_field_46）。可选拉取父需求、子需求；任意 custom_field_* 参数会直接透传。

**参数：**

| 参数名 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `releaseId` | string | 可选 | release ID |
| `iterationId` | string | 可选 | 迭代 ID |
| `id` | string | 可选 | 需求 ID，支持 1~N 个：单个 id=123；多个 id=1,2,3 或重复传 id=1&id=2 |
| `endDate` | string | 可选 | 截止日期（映射到 due） |
| `before` | string | 可选 | 截止日期前（due < before） |
| `type` | string | 可选 | 需求类型 |
| `modifyDays` | string | 可选 | 修改时间过滤 |
| `createDays` | string | 可选 | 创建时间过滤 |
| `status` | string | 可选 | 状态枚举：new=未开始 / planning=规划中 / audited=已评审 / in_progress=实现中 / status_1=合入中 / product_experience=验收中 / testing=测试中 / resolved=已实现 / suspended=挂起 |
| `name` | string | 可选 | 名称关键字 |
| `fields` | string | 可选 | 指定返回字段 |
| `area` | string | 可选 | 领域（映射到 custom_field_47） |
| `smallteam` | string | 可选 | 小组（映射到 custom_field_46） |
| `custom_field_*` | string | 可选 | 任意自定义字段，直接透传给 TAPD |
| `limit` | number | 可选 | 默认 1000（所有条件都为空时生效） |
| `needParents` | string | 可选 | 传任意非空值则附带父需求 |
| `needChildren` | string | 可选 | 传任意非空值则附带子需求 |
| `level` | string | 可选 | 数据密级 |

**请求示例：**

```bash
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story?area=干员&smallteam=A组&needParents=1"
# 按多个需求 ID 查询（逗号分隔）
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story?id=1020421949001234567,1020421949001234568"
```

**响应示例：**

```json
{ "total": 1234, "page": 1, "pageSize": 1000, "data": [{ "id": "...", "name": "...", "status": "...", "created": "...", "modified": "...", "iteration_id": "...", "release_id": "...", "owner": "...", "developer": "...", "area": "...", "smallteam": "..." }] }
```

---
