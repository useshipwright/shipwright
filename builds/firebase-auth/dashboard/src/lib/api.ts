const SERVICE_URL = process.env.FIREBASE_AUTH_SERVICE_URL || 'http://localhost:8080';
const IS_CLOUD_RUN = !!process.env.K_SERVICE;

async function getServiceHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

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
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const headers = await getServiceHeaders();
  const url = `${SERVICE_URL}${path}`;

  return fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
}
