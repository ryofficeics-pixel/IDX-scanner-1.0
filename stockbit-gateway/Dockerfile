FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    STOCKBIT_STORE_DIR=/data/stockbit \
    STOCKBIT_FORCE_FILE_STORE=1 \
    STOCKBIT_TRADING=off \
    STOCKBIT_NO_BROWSER=1 \
    STOCKBIT_TOOLS=core

WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /data/stockbit && chown node:node /data/stockbit

USER node
VOLUME ["/data/stockbit"]
EXPOSE 8787

CMD ["node", "src/server.js"]
