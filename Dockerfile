# Single image: builds the prerendered web app and runs the Node server.
FROM node:22-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && node -e "import('./server/binaries.mjs').then((m) => m.ensureBinaries({ dir: '.bin' }))" \
 && pnpm prune --prod
ENV HOST=0.0.0.0 PORT=8000 MYCONVERSOR_DATA=/data
VOLUME /data
EXPOSE 8000
CMD ["node", "server/index.mjs"]
