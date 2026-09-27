// Server entry point (`pnpm serve`, also started by `pnpm start`): makes sure
// FFmpeg and yt-dlp are available, then serves the API and the built web app.
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBinaries } from './binaries.mjs';
import { createApp } from './app.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');
const env = process.env;
const port = Number(env.PORT ?? 8000);

const bins = await ensureBinaries({
  dir: join(root, '.bin'),
  log: (m) => console.log(`[MyConversor] ${m}`),
});
const { app, close } = createApp({
  bins,
  dataDir: resolve(env.MYCONVERSOR_DATA ?? join(root, '.data')),
  webDir: env.MYCONVERSOR_WEB ?? join(root, 'dist/myconversor/browser'),
  ttlMs: Number(env.MYCONVERSOR_TTL_HOURS ?? 24) * 3600_000,
  guestTtlMs: Number(env.MYCONVERSOR_GUEST_TTL_HOURS ?? 2) * 3600_000,
  quotaBytes: Number(env.MYCONVERSOR_QUOTA_GB ?? 50) * 1024 ** 3,
  guestQuotaBytes: Number(env.MYCONVERSOR_GUEST_QUOTA_GB ?? 2) * 1024 ** 3,
  maxJobs: Number(env.MYCONVERSOR_MAX_JOBS ?? 2),
  cookies: env.MYCONVERSOR_COOKIES || undefined,
  log: console.error,
});

const server = createServer(app).listen(port, env.HOST ?? '127.0.0.1', () => {
  console.log(`[MyConversor] API ready at http://localhost:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
