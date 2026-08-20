FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmmirror.com \
    && npm cache clean --force

COPY --chown=node:node src ./src
RUN mkdir -p /data/audio && chown -R node:node /app /data/audio

USER node
EXPOSE 3001
CMD ["node", "src/index.js"]
