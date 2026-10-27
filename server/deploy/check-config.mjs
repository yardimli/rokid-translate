// Deliberately report field names, never their values.
import { pathToFileURL } from 'node:url';

export function validateDeployment(env) {
  if (!env.DASHBOARD_USERNAME || !env.DASHBOARD_PASSWORD || env.DASHBOARD_PASSWORD.length < 12) {
    throw new Error('Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD (at least 12 characters) in server/.env before deploying');
  }
  for (const key of ['DEVICE_TOKEN', 'DASHBOARD_TOKEN']) {
    if (!env[key] || env[key].length < 24 || env[key].startsWith('replace-')) throw new Error(`Set ${key} in the installed .env`);
  }
  if (env.DEVICE_TOKEN === env.DASHBOARD_TOKEN) throw new Error('DEVICE_TOKEN and DASHBOARD_TOKEN must differ');
  if (env.PUBLIC_ORIGIN !== 'https://translate.playground.computer') throw new Error('PUBLIC_ORIGIN must match the deployment domain');
  if ((env.HOST || '127.0.0.1') !== '127.0.0.1' || Number(env.PORT || 8787) !== 8787) throw new Error('Deployment requires HOST=127.0.0.1 and PORT=8787');
  for (const [key, directory] of [['LOG_DIR', 'logs'], ['RECORDINGS_DIR', 'recordings']]) {
    if (env[key] && ![directory, `./${directory}`, `/opt/rokid-translate/server/${directory}`].includes(env[key])) {
      throw new Error(`${key} must use the standard /opt/rokid-translate/server state directory for this deployment script`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { validateDeployment(process.env); console.log('Installed environment validated.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
