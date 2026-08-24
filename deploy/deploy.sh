#!/bin/bash
# ============================================================
# Vo Manager · 一键部署脚本（在 CVM 上执行）
# 用法：cd /root/vo-manager/deploy && bash deploy.sh
# ============================================================
set -e

echo "════════════════════════════════════════════════════"
echo "  🚀 Vo Manager · 一键部署"
echo "  CVM: $(hostname) · $(date '+%F %T')"
echo "════════════════════════════════════════════════════"

# 1. 环境准备
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)
echo "▶ 项目目录: $PROJECT_DIR"

# 2. 检查 Docker
if ! command -v docker &> /dev/null; then
  echo "▶ 正在安装 Docker（首次运行，约 2 分钟）..."
  curl -fsSL https://get.docker.com | bash
  systemctl enable --now docker
  echo "✓ Docker 安装完成"
else
  echo "✓ Docker 已装：$(docker --version)"
fi

# 3. 检查 docker compose
if ! docker compose version &> /dev/null; then
  echo "▶ 安装 docker-compose plugin..."
  yum install -y docker-compose-plugin 2>/dev/null || \
    dnf install -y docker-compose-plugin 2>/dev/null || \
    (mkdir -p /usr/local/lib/docker/cli-plugins && \
     curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
       -o /usr/local/lib/docker/cli-plugins/docker-compose && \
     chmod +x /usr/local/lib/docker/cli-plugins/docker-compose)
fi
echo "✓ Docker Compose: $(docker compose version | head -1)"

# 4. .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ 已生成 .env（可编辑后重新执行本脚本）"
fi

# 5. 启动服务
echo ""
echo "▶ 拉取镜像 + 构建后端 + 启动服务..."
docker compose down 2>/dev/null || true
docker compose up -d --build

# 6. 等待 MySQL 就绪
echo ""
echo "▶ 等待 MySQL 就绪..."
for i in $(seq 1 30); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' vo-mysql 2>/dev/null)" = "healthy" ]; then
    echo "✓ MySQL 就绪"
    break
  fi
  echo "  ...等待中 ($i/30)"
  sleep 3
done

# 7. 健康检查
echo ""
echo "▶ 健康检查..."
sleep 3
if curl -sf http://localhost/api/health > /tmp/vo_health.json; then
  echo "✓ 后端 API OK：$(cat /tmp/vo_health.json)"
else
  echo "⚠ 后端 API 未响应，查看日志：docker logs vo-backend"
fi

# 8. 完成
echo ""
echo "════════════════════════════════════════════════════"
echo "  ✅ Vo Manager 部署完成！"
echo ""
echo "  访问地址：http://$(hostname -I | awk '{print $1}')"
echo "  请通过受控内网、VPN 或配置 HTTPS 的反向代理访问。"
echo ""
echo "  常用命令："
echo "    docker compose logs -f backend    # 查看后端日志"
echo "    docker compose restart            # 重启所有"
echo "    docker compose down               # 停止服务"
echo "════════════════════════════════════════════════════"
