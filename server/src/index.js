import { createDiagnosticServer } from './server.js';

const app = createDiagnosticServer({
  deviceToken: process.env.DEVICE_TOKEN,
  dashboardToken: process.env.DASHBOARD_TOKEN,
  dashboardUsername: process.env.DASHBOARD_USERNAME,
  dashboardPassword: process.env.DASHBOARD_PASSWORD,
  origin: process.env.PUBLIC_ORIGIN,
  logDir: process.env.LOG_DIR || './logs',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  recordingsDir: process.env.RECORDINGS_DIR || './recordings',
  targetLanguage: process.env.TARGET_LANGUAGE || 'en',
});
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
app.server.listen(port, host, () => console.log(`Rokid diagnostic server listening on ${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
