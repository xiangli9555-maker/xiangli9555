FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
RUN if [ -f /app/package-lock.json ]; then npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com; else npm install --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com; fi \
    && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node cw_doc_recipe_v6.js ./

RUN mkdir -p /data/audio && chown -R node:node /app /data/audio

USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
