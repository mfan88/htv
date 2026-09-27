# htv server mode: scrapes onhockey.tv and checks NHL links around the clock, serving
# the results to the desktop app (Settings → htv server). See docker-compose.yml.
FROM node:24-bookworm-slim

# Electron's runtime libraries, plus Xvfb as a virtual display for its hidden windows.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini xvfb xauth ca-certificates fonts-liberation \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxshmfence1 libcups2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies plus Electron itself (a devDependency of the desktop build).
# Install scripts are skipped, so fetch Electron's binary explicitly.
RUN npm ci --omit=dev --ignore-scripts \
 && npm install --no-save --ignore-scripts "electron@$(node -p "require('./package.json').devDependencies.electron.replace(/^[^0-9]*/, '')")" \
 && node node_modules/electron/install.js \
 && npm cache clean --force

COPY src ./src

ENV HTV_DATA=/data \
    HTV_PORT=8787
VOLUME /data
EXPOSE 8787

# xvfb-run hangs as PID 1 (Electron never starts), so run it under tini.
# --log-level=3 hides Chromium's harmless D-Bus errors, logged for every window.
ENTRYPOINT ["tini", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x720x24", \
     "node_modules/.bin/electron", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--log-level=3", "src/server.js"]
