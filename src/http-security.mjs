const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function parseLocalHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) return null;
    return url;
  } catch {
    return null;
  }
}

export function isAllowedLocalRequest(request, expectedPort) {
  const hostHeader = request.headers.host;
  if (typeof hostHeader !== 'string') return false;

  const requestUrl = parseLocalHttpUrl(`http://${hostHeader}`);
  if (!requestUrl || Number(requestUrl.port || 80) !== expectedPort) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;

  const origin = request.headers.origin;
  if (origin === undefined) return true;

  const originUrl = parseLocalHttpUrl(origin);
  return originUrl !== null && originUrl.host === requestUrl.host;
}
