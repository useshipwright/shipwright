interface ProxyOptions {
  skipContentType?: boolean;
}

interface ProxyResult {
  data: unknown;
  status: number;
  ok: boolean;
}

export async function callProxy(
  path: string,
  method = 'GET',
  body?: unknown,
  options?: ProxyOptions
): Promise<ProxyResult> {
  const res = await fetch('/api/proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path,
      method,
      body,
      skipContentType: options?.skipContentType,
    }),
  });

  if (res.status === 204) {
    return { data: null, status: 204, ok: true };
  }

  const data = await res.json();
  return { data, status: res.status, ok: res.ok };
}

export function extractError(data: unknown): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as Record<string, unknown>).error;
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && 'message' in err) {
      return (err as { message: string }).message;
    }
  }
  return 'Unknown error';
}
