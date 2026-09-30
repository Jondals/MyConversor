# Single image: builds the prerendered web app and runs the Node server.
FROM node:22-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# yt-dlp's bgutil plugin fetches YouTube PO tokens from the bgutil-provider
# container (see .github/workflows/deploy.yml). It runs after `COPY . .`, so
# every deploy picks up the latest release, matching the provider image.
RUN pnpm build \
 && node -e "import('./server/binaries.mjs').then((m) => m.ensureBinaries({ dir: '.bin' }))" \
 && mkdir -p /root/.config/yt-dlp/plugins \
 && node -e "fetch('https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip').then(async (r) => { if (!r.ok) throw new Error('bgutil plugin: ' + r.status); require('fs').writeFileSync('/root/.config/yt-dlp/plugins/bgutil-ytdlp-pot-provider.zip', Buffer.from(await r.arrayBuffer())); })" \
 && pnpm prune --prod
ENV HOST=0.0.0.0 PORT=8000 MYCONVERSOR_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["node", "server/index.mjs"]
