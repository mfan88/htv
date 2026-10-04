# htv: scrapes onhockey.tv, checks NHL links with headless Chromium around the clock, and
# serves them to Jellyfin as a Live TV tuner. See docker-compose.yml.
FROM node:24-bookworm-slim

# tini as PID 1 reaps the Chromium child processes it leaves behind.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm ci --omit=dev \
 && npx playwright-core install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* && npm cache clean --force

COPY src ./src

ENV HTV_DATA=/data \
    HTV_PORT=8787
VOLUME /data
EXPOSE 8787

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
