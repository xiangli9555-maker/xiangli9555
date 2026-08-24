#!/bin/bash
# ============================================================
# Vo Manager · 全量备份脚本（在 CVM 上执行）
# 备份内容：① MySQL 数据库(mysqldump) ② 后端代码 + Nginx 配置
# 用法：cd /root/vo-manager/deploy && bash backup.sh
# 依赖：docker（用于连 vo-mysql 容器）、gzip、tar
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
BACKUP_DIR="${PROJECT_DIR}/backups"
RETENTION=7   # 保留最近 N 份

# 1. 读取 .env（若存在）
if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a; . "${PROJECT_DIR}/.env"; set +a
fi
DB_NAME="${DB_NAME:-vo_manager}"
DB_USER="${DB_USER:-vo_manager}"
DB_CONTAINER="${DB_CONTAINER:-vo-mysql}"
# 注意：DB_PASSWORD 必须来自 .env，禁止硬编码

mkdir -p "$BACKUP_DIR"
TS="$(date '+%Y%m%d-%H%M%S')"

echo "════════════════════════════════════════════════════"
echo "  💾 Vo Manager · 全量备份  ${TS}"
echo "════════════════════════════════════════════════════"

# 2. 数据库备份（单事务快照，避免锁表）
DB_FILE="${BACKUP_DIR}/vo_manager-${TS}.sql.gz"
echo "▶ 备份数据库 ${DB_NAME} ..."
if ! docker exec "$DB_CONTAINER" sh -c \
     "exec mysqldump -u\"$DB_USER\" -p\"$DB_PASSWORD\" --single-transaction --routines --triggers --hex-blob \"$DB_NAME\"" \
     | gzip > "$DB_FILE"; then
  echo "✗ 数据库备份失败（检查 DB_CONTAINER / DB_USER / DB_PASSWORD）" >&2
  exit 1
fi
echo "✓ 数据库已备份: ${DB_FILE} ($(du -h "$DB_FILE" | cut -f1))"

# 3. 代码 + Nginx 配置备份（排除 node_modules / .git / 旧备份）
CODE_FILE="${BACKUP_DIR}/vo_code-nginx-${TS}.tar.gz"
echo "▶ 备份代码与 Nginx 配置 ..."
tar --exclude='./node_modules' --exclude='./.git' --exclude='./backups' \
    --exclude='./.env' -czf "$CODE_FILE" \
    ./backend ./nginx ./frontend ./docker-compose.yml ./README.md ./一键部署命令.md ./backup.sh ./restore.sh ./import_tapd.js 2>/dev/null \
 || tar --exclude='node_modules' --exclude='.git' --exclude='backups' \
    --exclude='.env' -czf "$CODE_FILE" .
echo "✓ 代码/Nginx 已备份: ${CODE_FILE} ($(du -h "$CODE_FILE" | cut -f1))"

# 4. 校验
echo "▶ 校验备份完整性 ..."
if [ ! -s "$DB_FILE" ] || [ ! -s "$CODE_FILE" ]; then
  echo "✗ 备份文件为空，中止" >&2
  exit 1
fi
gunzip -t "$DB_FILE" && echo "✓ DB 压缩包可解压"
tar -tzf "$CODE_FILE" >/dev/null && echo "✓ 代码包可解压"

# 5. 清理旧备份
echo "▶ 清理旧备份（保留最近 ${RETENTION} 份）..."
ls -1t "${BACKUP_DIR}"/vo_manager-*.sql.gz 2>/dev/null | tail -n +$((RETENTION+1)) | xargs -r rm -f
ls -1t "${BACKUP_DIR}"/vo_code-nginx-*.tar.gz 2>/dev/null | tail -n +$((RETENTION+1)) | xargs -r rm -f

echo ""
echo "✅ 备份完成。存放于: ${BACKUP_DIR}"
echo "   恢复命令: bash restore.sh ${DB_FILE} ${CODE_FILE}"
