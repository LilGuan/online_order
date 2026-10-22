export const API_BASE = window.ONLINE_ORDER_BACKEND_URL || window.location.origin;

export async function requestJson(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
  return data;
}

export function assetUrl(value) {
  const image = String(value || '').trim();
  if (!image || /^(https?:|data:|blob:)/i.test(image)) return image;
  return new URL(image.replace(/^\/+/, ''), `${API_BASE}/`).href;
}
