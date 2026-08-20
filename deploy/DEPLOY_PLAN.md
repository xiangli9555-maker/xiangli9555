# Vo Manager · 分阶段部署 Runbook（含回滚）

> 适用范围：将本轮安全加固 + 实时发布计划 + talent 命名迁移部署到 CVM 生产。
> 原则：**未经验证不部署生产**。本文件是「部署准备 + 执行清单 + 回滚预案」，
> 实际 `docker compose up` 只在 CVM 上、且通过下方每一道 Go/No-Go 闸门后才执行。

---

## 0. 变更范围（本轮）

| 项 | 内容 | 关键文件 |
|----|------|---------|
| 备份 | DB+代码+Nginx 归档、还原脚本 | `backup.sh` / `restore.sh` |
| 安全 | Bearer 鉴权 / RBAC / CORS 白名单 / 安全响应头 / 限流 | `src/security.js` |
| HTTPS | nginx 80→443 跳转 + TLS + HSTS + certbot 挂载 | `nginx/default.conf` / `HTTPS.md` |
| 声优库 | upsert + 事务 + 软删 + 审计 | `src/index.js` / `src/audit.js` |
| 上传 | 聚合存储配额（10GB 默认） | `src/index.js` `/api/storage/quota` |
| 档期 | 批量发布事务化（消除部分成功） | `src/index.js` `/api/schedules/publish` |
| 日期 | 统一日期引擎 + 调休日历 | `src/calendar.js` `/api/calendar` |
| 发布计划 | 实时聚合接口（本地 DB 真源 + 可选 DFAI） | `src/releasePlan.js` `/api/release-plans` `/api/calendar-entries` |
| 命名 | roster→talent：`/api/talents` 别名（表名不变） | `src/index.js` 路由复用 |

---

## 1. 部署前清单（Pre-flight，必须全绿）

- [ ] **备份现有生产**（见 Phase 0）—— 未备份禁止继续。
- [ ] `.env` 已就位：`DB_PASSWORD`、`API_TOKENS_JSON`（≥32 字符 token）、`ALLOWED_ORIGINS`、`MAX_STORAGE_BYTES`。
- [ ] `DFAI_TOKEN` 视需要填写（空则发布计划走本地真源，不影响启动）。
- [ ] 证书：`certs/` 目录存在且含 `fullchain.pem` / `privkey.pem`（certbot 或自签），否则 nginx 起不来。
- [ ] CVM 数据盘剩余空间 > 镜像+音频增量（默认音频卷 `audio_data`）。
- [ ] 维护窗口已公告（建议低峰期，预计停机 < 5 分钟）。

---

## 2. 分阶段执行

### Phase 0 · 备份（先于一切写操作）
```bash
cd /root/deploy && bash backup.sh
# 产物：backups/vo-manager-deploy-backup-<日期>.tar.gz + <日期>.sql
# 校验：ls -lh backups/ && tar -tzf <sql/归档名> | head
```

### Phase 1 · 交付代码 + 构建
```bash
# 本地已打 deploy 包并上传；CVM 上解压后：
cd /root/deploy
git pull || true            # 或解压新的 deploy 包
docker compose build backend # 只重建后端镜像（前端随 nginx 静态卷）
```

### Phase 2 · 数据库迁移（幂等，随后端启动自动执行）
- 后端启动时会自动跑：`DEMANDS_READY`（补 `voice_estimates` 等列）、`AUDIT_READY`（`audit_log` 表）、`KV_READY`（`kv_store` 表）。
- **这些都不删数据、可重复执行**。仍建议 Phase 0 备份兜底。
- 若需手动：
```bash
docker compose exec mysql mysql -u$DB_USER -p$DB_PASSWORD $DB_NAME -e "SHOW TABLES;"
```

### Phase 3 · 启动服务（先后端+DB，再 nginx）
```bash
docker compose up -d mysql backend
sleep 5
docker compose up -d nginx
```

### Phase 4 · HTTPS / 证书
```bash
# certbot 模式（推荐，自动续期）：
CERT_DIR=./certs docker compose up -d --build
# 自签模式见 HTTPS.md；确认 443 监听、80→443 跳转生效。
```

### Phase 5 · 冒烟测试（Go/No-Go 闸门）
```bash
bash smoke-test.sh http://localhost <ADMIN_TOKEN>
# 必须全部 OK：health / calendar / release-plans / talents(别名) / voice-roles(历史) / storage-quota
```

---

## 3. Go / No-Go 闸门

| 闸门 | 通过条件 | 不通过动作 |
|------|---------|-----------|
| G1 备份 | Phase 0 产物存在且可解压 | 中止部署 |
| G2 构建 | `docker compose build` 无错 | 排查 Dockerfile / 依赖 |
| G3 启动 | `vo-backend` 容器 `healthy`、MySQL healthy | 看 `docker logs vo-backend`；回滚 |
| G4 鉴权 | 无 token 访问 `/api/*` 返回 401 | 检查 `API_TOKENS_JSON` |
| G5 冒烟 | smoke-test 全 OK | 回滚到上一镜像 |
| G6 HTTPS | 443 可握手、HSTS 头存在 | 检查 `certs/` 与 nginx 配置 |

---

## 4. 回滚预案

### 4.1 后端代码回滚（最常用）
```bash
cd /root/deploy
git checkout <上一稳定 commit>        # 或解压上一版 deploy 包
docker compose up -d --build backend
bash smoke-test.sh http://localhost <ADMIN_TOKEN>
```

### 4.2 数据库回滚（仅当迁移异常且无法正向修复）
```bash
cd /root/deploy
bash restore.sh backups/<日期>.sql backups/<日期>.tar.gz
# restore.sh 会建库（若缺失）并导入 dump，同时解压代码/nginx（保留现有 .env）
docker compose restart
```

### 4.3 全量回滚（灾难级）
```bash
docker compose down
# 从 Phase 0 归档整体恢复（代码+nginx+db dump 一并还原），再 docker compose up -d
```

### 4.4 回滚校验
- 回滚后必跑 `smoke-test.sh`，确认 `health`、`talents`、`voice-roles`、`release-plans` 均 OK。
- 通知公告维护窗口结束。

---

## 5. 部署后监控（首 24h）

- `docker compose logs -f backend` 关注 `ERROR` / `dfai 拉取失败`（dfai 缺失属预期，仅告警）。
- 审计日志：`SELECT * FROM audit_log ORDER BY id DESC LIMIT 50;` 确认关键写操作有记录。
- 存储配额：`GET /api/storage/quota` 关注 `used/quota` 占比。
- 发布计划：前端「版本节点」页数据源标签应显示 `live` 或 `cache`，非 `不可用`。

---

## 6. 注意事项

- **不要**在生产直接手改 DB 权威字段（demands 的 TAPD 字段只能经快照导入）。
- **不要**删除 `certs/`、`backups/`（已在 .gitignore）。
- 回滚以「镜像/commit」为单位，DB 迁移向前兼容；如确需回退表结构，必须走 4.2 整库还原。
- 本轮**未执行任何生产部署**，仅完成代码加固 + 回归 + 本 Runbook。实际 `docker compose up` 需在有 CVM 访问权且通过上述闸门后由运维执行。
