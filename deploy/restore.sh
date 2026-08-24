#!/bin/bash
# ============================================================
# Vo Manager · 恢复脚本（在 CVM 上执行）
# 用法：
#   bash restore.sh <db_dump.sql.gz> <code_nginx.tar.gz>
# 说明：
#   - 数据库：先建库（若不存在），再导入 dump
#   - 代码：解包到当前 deploy 目录（不覆盖 .env，避免密钥丢失）
# ============================================================
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "用法: bash restore.sh <db_dump.sql.gz> <code_nginx.tar.gz>" >&2
  exit 1
fi
DB_FILE="$1"; CODE_FILE="$2"

cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
if [ -f "${PROJECT_DIR}/.env" ]; then set -a; . "${PROJECT_DIR}/.env"; set +a; fi
DB_NAME="${DB_NAME:-vo_manager}"
DB_USER="${DB_USER:-vo_manager}"
DB_CONTAINER="${DB_CONTAINER:-vo-mysql}"

echo "════════════════════════════════════════════════════"
echo "  🔄 Vo Manager · 恢复"
echo "════════════════════════════════════════════════════"

# 1. 恢复数据库
echo "▶ 恢复数据库 ${DB_NAME} ..."
docker exec "$DB_CONTAINER" sh -c "exec mysql -u\"$DB_USER\" -p\"$DB_PASSWORD\" -e 'CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4;'" 
gunzip -c "$DB_FILE" | docker exec -i "$DB_CONTAINER" sh -c "exec mysql -u\"$DB_USER\" -p\"$DB_PASSWORD\" \"$DB_NAME\""
echo "✓ 数据库已恢复"

# 2. 恢复代码（不覆盖现有 .env）
echo "▶ 恢复代码与 Nginx 配置（保留现有 .env）..."
TMP_EXTRACT="$(mktemp -d)"
tar -xzf "$CODE_FILE" -C "$TMP_EXTRACT"
# 仅覆盖 backend / nginx / frontend / 部署文件，保留本地 .env
cp -r "${TMP_EXTRACT}/backend" "${TMP_EXTRACT}/nginx" "${TMP_EXTRACT}/frontend" "${PROJECT_DIR}/" 2>/dev/null || true
[ -f "${TMP_EXTRACT}/docker-compose.yml" ] && cp "${TMP_EXTRACT}/docker-compose.yml" "${PROJECT_DIR}/"
rm -rf "$TMP_EXTRACT"
echo "✓ 代码已恢复"

echo ""
echo "✅ 恢复完成。请执行: docker compose up -d --build"
