# Nexus Desk: the web app, the API, the 24/7 position guardian and the
# market scanner, in one always-running container.
#
#   docker build -t nexus-desk .
#   docker run -p 3000:3000 --env-file .env -v nexus-data:/data nexus-desk
#
# Everything the server must keep across restarts (guardian positions,
# live-order records, desk settings, tracked setups) is written to /data:
# mount a persistent volume there.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NEXUS_DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3000
# Unhealthy when the scanner's candle-close loop has stopped running.
HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Runs as root only long enough to give /data to the "node" user, then as "node".
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.cjs"]
