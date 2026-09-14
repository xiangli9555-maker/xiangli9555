# 2026-09-14：基础镜像 alpine(musl) → Debian slim(glibc)。
# 原因：档期实时刷新要跑 wecom-cli 原生二进制与 python3，二者在 musl 下均不可用（二进制为 glibc 构建）。
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN if [ -f /app/package-lock.json ]; then npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com; else npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com; fi \
    && npm cache clean --force

# 档期实时刷新链路：python3 跑表格解析脚本；ca-certificates 供 wecom-cli 走 HTTPS
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node src ./src
COPY --chown=node:node tools ./tools
COPY --chown=node:node cw_doc_recipe_v6.js ./
COPY --chown=node:node schedule_from_sheet.json ./

# /home/node/.config/wecom 由 compose 只读挂载凭证文件，cache 子目录需可写（node 用户）
RUN mkdir -p /data/audio /home/node/.config/wecom/cache && chown -R node:node /app /data/audio /home/node/.config

USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
