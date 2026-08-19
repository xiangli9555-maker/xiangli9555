# TAPD 集成规范 · Vo Manager（DFAI 内部 API 版）

> **版本**：v2.1 · 2026-07-17
> **产品负责人**：lycheelli (PM)
> **交付对象**：后端工程师 / DevOps
> **API 来源**：DFAI 平台（<https://dfai.woa.com>）— 已封装 TAPD `getRedisStories`
> **前置文档**：`开发交接文档.md`

---

## 🎯 v1 定版筛选条件（PM 已确认，本节最重要）

**同步范围**：只拉 **TAPD 需求类型 = "音频"** 且 **状态 ≠ 挂起** 的所有需求。

**同步字段**：严格按 PM 截图里的 TAPD 列头 7 个字段：
1. 发布计划 → `release_plan`
2. Area → `area`
3. 标题 → `task_name`
4. 创建人 → `creator`
5. 开发人员 → `developer`
6. 状态 → `status`（原值直存）
7. 处理人 → `handler`

**默认 curl（生产用）**：
```bash
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story?type=音频&status=new,planning,audited,in_progress,status_1,product_experience,testing,resolved&needParents=1&limit=500"
```

---

## 1. 目标

通过 **DFAI 内部 API** 拉取 TAPD 中「语音需求」到 Vo Manager 的 `demands` 表，PM 不再重复录入。

**为什么用 DFAI 而不是原生 TAPD API？**

| 对比项 | 原生 TAPD Open API | **DFAI /aiapi/get_story** |
|--------|-------------------|----------------------------|
| 鉴权 | Basic Auth（api_user:password） | **Bearer Token（更简单）** |
| 性能 | 直连 TAPD，冷查询慢 | **走 Redis 缓存，热查询快** |
| 迭代联查 | 需二次查询 iteration 表 | **响应直接含 iteration_id / release_id** |
| 自定义字段 | 需知道字段编号，手动解析 | **area / smallteam 已经语义化** |
| 父/子需求 | 手动递归查询 | **needParents / needChildren 一键带出** |
| 稳定性 | TAPD 限流可能影响 | **DFAI 有独立限流保护** |

---

## 2. 前置条件（PM 需提供）

| # | 项目 | 说明 | 状态 |
|---|------|------|------|
| 1 | **DFAI API Token** | 在 DFAI 平台申请，用于 `Authorization: Bearer <TOKEN>` | ⏳ 待提供 |
| 2 | **接口 URL** | `https://dfai.woa.com/aiapi/get_story` | ✅ 已知 |
| 3 | **Area / Smallteam 值域** | 你们组的 area/smallteam 具体填什么 | ⏳ PM 确认 |
| 4 | **同步筛选条件** | 见第 3 节 | ⏳ PM 确认 |

> 🔒 **Token 存后端环境变量 `DFAI_API_TOKEN`**，绝不下发前端。前端通过我们自己的 `/api/v1/tapd/sync` 端点鉴权（JWT）。

---

## 3. 同步范围与筛选

默认 curl 示例（v1 生产参数 · PM 定版）：

```bash
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story\
?type=音频\
&status=new,planning,audited,in_progress,status_1,product_experience,testing,resolved\
&needParents=1\
&limit=500"
```

**参数说明**：

| 参数 | 值 | 意义 | 是否必须 |
|------|---|------|--------|
| **`type`** | **`音频`** | **需求类型硬筛选（v1 定版）** | 🔴 **必须** |
| `area` | 空 = 全部 · 或 `干员` / `AI` / `SOL` / `MP` | 领域筛选（→ custom_field_47） | 可选 |
| `smallteam` | `A组` / `语音组` | 小组筛选（→ custom_field_46） | 可选 |
| `status` | `new,planning,audited,in_progress,status_1,product_experience,testing,resolved` | **8 种活跃状态，排除 suspended（挂起）** | 🔴 **必须** |
| `needParents` | `1` | 附带父需求（便于展示层级） | 可选 |
| `limit` | `500` | 单次拉取上限，默认 1000 | 可选 |
| `modifyDays` | `7` | 只拉近 7 天修改过的（增量同步用） | 可选 |

**🎯 v1 定版筛选条件（PM 已确认）**：
- ✅ `type=音频` — 只拉音频类需求
- ✅ `status` 排除 `suspended` — 不拉挂起状态
- ✅ area / smallteam 不做硬限制，前端可再筛

---

## 4. 状态枚举转换

DFAI 返回 **9 种** status，我们内部用 **4 种** — 需要做映射：

| DFAI status | Vo Manager status | 说明 |
|-------------|-------------------|------|
| `new` · 未开始 | `pending` | 待开始 |
| `planning` · 规划中 | `pending` | 待开始 |
| `audited` · 已评审 | `pending` | 待开始 |
| `in_progress` · 实现中 | `progress` | 进行中 |
| `status_1` · 合入中 | `progress` | 进行中 |
| `product_experience` · 验收中 | `sync` | 音画同步 |
| `testing` · 测试中 | `sync` | 音画同步 |
| `resolved` · 已实现 | `done` | 已完成 |
| `suspended` · 挂起 | 不同步 | 跳过 |

**代码实现**：
```python
STATUS_MAP = {
    'new': 'pending',
    'planning': 'pending',
    'audited': 'pending',
    'in_progress': 'progress',
    'status_1': 'progress',
    'product_experience': 'sync',
    'testing': 'sync',
    'resolved': 'done',
}

def map_status(dfai_status):
    return STATUS_MAP.get(dfai_status)  # None 时跳过
```

---

## 5. 字段映射（v1 定版 · TAPD 7 字段严格对齐）

### 5.1 主映射表

按 PM 提供的 TAPD 列头（发布计划 / Area / 标题 / 创建人 / 开发人员 / 状态 / 处理人）7 字段严格对齐：

| # | TAPD 字段（PM 截图列头） | DFAI 响应字段 | Vo Manager 字段 | 类型 | 说明 |
|---|-------------------------|--------------|-----------------|------|------|
| 1 | **发布计划** | `release_id` → 联查得 `release.name` | `demands.release_plan` | VARCHAR(32) | 如 `Yang1` |
| 2 | **Area** | `area`（= custom_field_47） | `demands.area` | VARCHAR(32) | AI / SOL / MP / 干员 |
| 3 | **标题** | `name` | `demands.task_name` | VARCHAR(128) | 去首尾空格 |
| 4 | **创建人** | `creator` | `demands.creator` | VARCHAR(32) | TAPD 中"+ 快速创建"的人 |
| 5 | **开发人员** | `developer` | `demands.developer` | VARCHAR(32) | 逗号分隔多人时保留完整字符串 |
| 6 | **状态** | `status` | `demands.status` | VARCHAR(32) | **原值直存，不做转换** |
| 7 | **处理人** | `current_owner` | `demands.handler` | VARCHAR(32) | 当前流转到谁手上 |
| — | 需求类型（隐含） | `type` | 不入库（用作筛选） | — | 硬编码为 `音频` |
| — | 唯一标识 | `id` | `demands.external_id` | BIGINT | UPSERT 去重键 |
| — | 修改时间 | `modified` | `demands.updated_at` | DATETIME | |

### 5.2 数据表变更（DBA 执行 · 相较旧版有调整）

```sql
-- 首次执行
ALTER TABLE demands
  ADD COLUMN external_id BIGINT UNIQUE COMMENT 'TAPD Story ID',
  ADD COLUMN release_plan VARCHAR(32) NULL COMMENT '发布计划名，如 Yang1',
  ADD COLUMN story_type VARCHAR(32) DEFAULT '音频' COMMENT '需求类型',
  ADD COLUMN creator VARCHAR(32) NULL COMMENT 'TAPD 创建人',
  ADD COLUMN developer VARCHAR(64) NULL COMMENT 'TAPD 开发人员',
  ADD COLUMN handler VARCHAR(32) NULL COMMENT 'TAPD 当前处理人',
  ADD COLUMN sync_source VARCHAR(16) DEFAULT 'manual' COMMENT 'dfai / manual',
  ADD COLUMN last_synced_at DATETIME NULL,
  ADD INDEX idx_external (external_id),
  ADD INDEX idx_release_area (release_plan, area);

-- 若旧字段（planner / writer / summary / sync）不再使用，v2 可删除
-- ALTER TABLE demands DROP COLUMN req_planner, DROP COLUMN script_planner;
```

### 5.3 状态字段：不做转换

⚠️ **v1 决策变更**：`status` 直接存 TAPD 原值（`new`/`planning`/`audited`/... 共 8 种），**前端做展示层映射**。理由：
- 减少同步复杂度
- 保留原始信息，便于反查 TAPD
- 前端 `statusTag()` 函数已支持全量状态展示

---

## 6. 后端实现

### 6.1 架构

```
┌──────────┐   HTTP  ┌────────────────┐   Bearer   ┌──────────┐
│ 前端按钮 │ ──────▶ │  /api/v1/tapd/ │ ─────────▶ │   DFAI   │
│ 手动触发 │         │   sync (POST)  │            │  aiapi   │
└──────────┘         └────────┬───────┘            └────┬─────┘
                              │                          │ getRedisStories
                              ▼                          ▼
                     ┌────────────────┐         ┌──────────────┐
                     │  MySQL demands │         │  TAPD Redis  │
                     │  表 UPSERT     │         │  Cache       │
                     └────────────────┘         └──────────────┘
```

### 6.2 后端伪代码（Python 示例）

```python
import requests
import re
from datetime import datetime

DFAI_ENDPOINT = "https://dfai.woa.com/aiapi/get_story"
DFAI_TOKEN = os.environ["DFAI_API_TOKEN"]

STATUS_MAP = {...}  # 见第 4 节

def fetch_stories(area='干员', smallteam='A组', status='new,planning,audited,in_progress'):
    """从 DFAI 拉取需求列表"""
    r = requests.get(
        DFAI_ENDPOINT,
        headers={'Authorization': f'Bearer {DFAI_TOKEN}'},
        params={
            'area': area,
            'smallteam': smallteam,
            'status': status,
            'needParents': '1',
            'limit': '500',
        },
        timeout=30
    )
    r.raise_for_status()
    return r.json().get('data', [])

def sync_tapd():
    """核心同步流程"""
    log = SyncLog.start(source='dfai')
    try:
        stories = fetch_stories()

        for s in stories:
            mapped_status = STATUS_MAP.get(s.get('status'))
            if mapped_status is None:
                continue  # suspended 等跳过

            data = {
                'external_id': int(s['id']),
                'task_name': s['name'].strip(),
                'status': mapped_status,
                'version': normalize_version(s.get('iteration_id')),
                'release_id': s.get('release_id'),
                'area': s.get('area'),
                'req_planner': s.get('owner'),
                'script_planner': s.get('developer'),
                'updated_at': s.get('modified'),
                'created_at': s.get('created'),
            }

            # UPSERT（按 external_id 去重）
            demand = Demand.query.filter_by(external_id=data['external_id']).first()
            if demand is None:
                Demand.create(sync_source='dfai', last_synced_at=datetime.now(), **data)
                log.inserted += 1
            elif demand.sync_source == 'manual':
                # 手动创建的记录，只更新 status，不覆盖其他
                demand.update(status=mapped_status, last_synced_at=datetime.now())
                log.updated += 1
            elif demand.needs_update(data):
                demand.update(last_synced_at=datetime.now(), **data)
                log.updated += 1
            else:
                log.skipped += 1

        log.finish(status='ok')
    except requests.HTTPError as e:
        log.finish(status='fail', error=f'DFAI HTTP {e.response.status_code}')
        alert_admin(e)
    except Exception as e:
        log.finish(status='fail', error=str(e))
        alert_admin(e)
```

### 6.3 端点定义（后端对外）

```
POST /api/v1/tapd/sync
  Auth:  JWT (admin/pm role)
  Body:  { force?: boolean, area?: string, smallteam?: string, status?: string[] }
  Resp:  { code: 0, data: {
    total: 42,
    inserted: 3,
    updated: 8,
    skipped: 31,
    failed: 0,
    duration_ms: 1830
  }}

GET  /api/v1/tapd/status
  Resp:  { code: 0, data: {
    endpoint: "https://dfai.woa.com/aiapi/get_story",
    last_synced_at: "2026-07-17T14:23:11+08:00",
    total_synced: 42,
    health: "ok" | "warning" | "fail",
    last_error: null
  }}

POST /api/v1/tapd/test-connection
  Auth:  JWT (admin only)
  Body:  { area, smallteam }
  Resp:  { code: 0, data: { connected: true, story_count: 42 } }
  实现: 拿默认参数 + limit=1 打一次真实请求

GET  /api/v1/tapd/config
POST /api/v1/tapd/config
  管理 area / smallteam / status 等筛选参数，存 DB
```

### 6.4 定时任务

```python
# celery beat / apscheduler
@scheduler.scheduled_job('interval', minutes=15)
def periodic_tapd_sync():
    sync_tapd()
```

或直接 cron：`*/15 * * * * curl -X POST /api/v1/tapd/sync -H "Authorization: Bearer <INTERNAL>"`

---

## 7. 前端表现

### 7.1 需求汇总页顶部状态条

```
┌─────────────────────────────────────────────────────────────┐
│ [TAPD] [via DFAI]  上次同步：5 分钟前 · 12 条需求 · ✓ 正常   │
│                          端点：dfai.woa.com/aiapi/get_story  │
│                                        查看映射规则 →         │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 配置弹窗字段

- API Endpoint（只读）：`https://dfai.woa.com/aiapi/get_story`
- DFAI Bearer Token（密码框，只写不回显）
- Area 下拉：干员 / AI / SOL / MP
- Smallteam 文本框
- Status 多选：new / planning / audited / in_progress / testing / resolved
- needParents / needChildren 复选框
- 同步频率：15 分钟 / 1 小时 / 手动

### 7.3 按钮交互

- **测试连接**：调 `/api/v1/tapd/test-connection` → 返回命中数量 → toast
- **保存并同步**：先保存配置 → 立刻触发一次 sync → 状态条实时刷新

---

## 8. 监控告警

| 告警条件 | 通知渠道 | 严重级别 |
|---------|---------|---------|
| 连续 3 次同步失败 | 企业微信 + 邮件 | P1 |
| 单次同步 `failed > 5` | 企业微信 | P2 |
| DFAI 返回 401（Token 失效） | 电话 + 企业微信 | P0 |
| 单次同步耗时 > 30s | 企业微信 | P3 |
| 数据一致性巡检 diff > 5 | 企业微信 | P2 |

---

## 9. 测试要点

| # | 场景 | 预期 |
|---|------|------|
| 1 | 首次同步 | 正确插入所有匹配 story，`sync_source=dfai` |
| 2 | 增量同步 | 只更新有变化的记录，无变化 skip |
| 3 | DFAI Token 失效（401） | 立即报错 + 告警，本地数据保留 |
| 4 | DFAI 超时（30s） | 重试 3 次，每次间隔 5s |
| 5 | area 值非枚举（如"未知"） | 单条跳过 + 日志，不中断整批 |
| 6 | iteration_id 无法映射为 Yang* | 归入 Unknown 版本 |
| 7 | 手动创建的记录（sync_source=manual） | 只覆盖 status，保留手动填的其他字段 |
| 8 | 并发（定时 + 手动同时触发） | 分布式锁 Redis SETNX，后来者返回 202 |
| 9 | DFAI 返回 500 | 报警但不中断，5 分钟后重试 |
| 10 | `suspended` 状态 story | 不入库（不删除已存在的） |

---

## 10. 工时估算

| 阶段 | 工作 | 工时 |
|------|------|------|
| M1 | 表变更 + DFAI 客户端封装 + 单测 | 1d |
| M2 | 同步核心 + UPSERT + 状态映射 | 1.5d |
| M3 | 3 个 API 端点 + JWT 校验 | 1d |
| M4 | 前端配置弹窗联调 | 0.5d |
| M5 | 定时任务 + Redis 分布式锁 | 0.5d |
| M6 | 监控告警 + 日志埋点 | 0.5d |
| M7 | 全流程测试 + 数据一致性巡检 | 1d |
| **合计** | | **~6d**（比原生 TAPD 快 3 天） |

---

## 11. 里程碑

| Day | 里程碑 |
|-----|--------|
| 1 | PM 提供 DFAI Token + area/smallteam 值域 |
| 2 | 后端 Dev 环境跑通首次 sync |
| 4 | 接入 Staging，PM 验收数据准确性 |
| 5 | 定时任务 + 告警上线 |
| 6 | 上线 Prod，PM 停止在 Vo Manager 手工建需求 |

---

## 12. 环境变量清单

```bash
# 生产环境
DFAI_API_ENDPOINT=https://dfai.woa.com/aiapi/get_story
DFAI_API_TOKEN=<向 DFAI 平台申请>
TAPD_SYNC_AREA=干员
TAPD_SYNC_SMALLTEAM=A组
TAPD_SYNC_STATUS=new,planning,audited,in_progress
TAPD_SYNC_NEED_PARENTS=1
TAPD_SYNC_INTERVAL_SECONDS=900     # 15 分钟
TAPD_SYNC_TIMEOUT_SECONDS=30
TAPD_SYNC_MAX_RETRIES=3
TAPD_SYNC_ALERT_WEBHOOK=https://qyapi.weixin.qq.com/...
```

---

## 附录 A：真实 curl 示例

```bash
# 拉取所有干员组 A 组的活跃需求，附带父需求
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story\
?area=%E5%B9%B2%E5%91%98\
&smallteam=A%E7%BB%84\
&status=new,planning,audited,in_progress\
&needParents=1\
&limit=500"

# 按 ID 精确查询
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story?id=1020421949001234567,1020421949001234568"

# 只拉近 7 天修改过的（增量）
curl -H "Authorization: Bearer $DFAI_API_TOKEN" \
  "https://dfai.woa.com/aiapi/get_story?area=干员&modifyDays=7"
```

---

**文档负责人**：lycheelli · 有疑问 @她
**参考**：`dfai-api-docs-2026-07-17.md`（DFAI 官方接口文档）
