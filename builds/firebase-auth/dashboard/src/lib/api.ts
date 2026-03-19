const SERVICE_URL = process.env.FIREBASE_AUTH_SERVICE_URL || 'http://localhost:8080';
const SERVICE_API_KEY = process.env.FIREBASE_AUTH_SERVICE_API_KEY || '';
const IS_CLOUD_RUN = !!process.env.K_SERVICE;

async function getServiceHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  if (SERVICE_API_KEY) {
    headers['X-API-Key'] = SERVICE_API_KEY;
  }

  if (IS_CLOUD_RUN) {
    const tokenUrl = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${SERVICE_URL}`;
    const res = await fetch(tokenUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
    });
    if (!res.ok) {
      throw new Error(`Metadata token request failed: ${res.status}`);
    }
    headers['Authorization'] = `Bearer ${await res.text()}`;
  }

  return headers;
}

export async function callService(
  path: string,
  options: { method?: string; body?: unknown; skipContentType?: boolean } = {}
): Promise<Response> {
  const headers = await getServiceHeaders();
  if (options.skipContentType || !options.body) {
    delete headers['Content-Type'];
  }
  const url = `${SERVICE_URL}${path}`;

  return fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
}
