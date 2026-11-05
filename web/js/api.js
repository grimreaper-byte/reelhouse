// JSON API client. Every request carries the X-Requested-With header the server requires
// for state-changing calls (CSRF protection).

const listeners = new Set();
export const onUnauthorized = (fn) => listeners.add(fn);

async function request(method, url, body, { signal, keepalive, type } = {}) {
  const headers = { 'x-requested-with': 'reelhouse' };
  // A file (a Blob) goes as the body itself, with its own type; anything else as JSON.
  const raw = body instanceof Blob;
  if (body !== undefined) headers['content-type'] = raw ? type || body.type || 'application/octet-stream' : 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined || raw ? body : JSON.stringify(body),
    credentials: 'same-origin',
    signal,
    keepalive,
  });
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    // /api/me is how boot() discovers it's signed out; it handles that itself.
    if (res.status === 401 && !url.startsWith('/api/auth/') && url !== '/api/setup' && url !== '/api/me') {
      for (const fn of listeners) fn(data);
    }
    const err = new Error((isJson && data?.error) || (typeof data === 'string' && data.length < 200 && data) || res.statusText || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}, opts) => request('PUT', url, body, opts),
  patch: (url, body = {}, opts) => request('PATCH', url, body, opts),
  del: (url, opts) => request('DELETE', url, undefined, opts),
  /** Sends a file as the request body (PUT). */
  upload: (url, file, opts) => request('PUT', url, file, opts),
};
