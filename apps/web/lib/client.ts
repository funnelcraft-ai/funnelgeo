/** Browser-side call to the API through this app's own /api proxy. */
export async function send<T = any>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? 'Something went wrong. Try again.');
  return json as T;
}

/** Uploads one image file as the raw request body. */
export async function uploadImage<T = any>(path: string, file: File): Promise<T> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > 1024 * 1024) throw new Error('That file is too large. The limit is 1 MB.');
  const res = await fetch(`/api${path}`, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? 'The upload failed. Try again.');
  return json as T;
}
