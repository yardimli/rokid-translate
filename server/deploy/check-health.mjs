import { pathToFileURL } from 'node:url';

export function healthyResponse(text) {
  try {
    const value = JSON.parse(text);
    return value.ok === true && value.mode === 'translation-relay';
  } catch { return false; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let body = '';
  for await (const chunk of process.stdin) {
    body += chunk;
    if (body.length > 4096) { process.exitCode = 1; process.stdin.destroy(); break; }
  }
  if (body.length > 4096 || !healthyResponse(body)) process.exitCode = 1;
}
