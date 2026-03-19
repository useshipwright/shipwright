import { NextRequest, NextResponse } from 'next/server';
import { callService } from '@/lib/api';

const EXACT_PATHS = new Set([
  '/health',
  '/verify',
  '/batch-verify',
  '/users',
  '/users/batch',
  '/users/batch-delete',
  '/sessions',
  '/sessions/verify',
  '/tokens/custom',
  '/email-actions/password-reset',
  '/email-actions/verification',
  '/email-actions/sign-in',
]);

const PARAM_PATTERNS = [
  /^\/users\/by-email\/[^/]+$/,
  /^\/users\/by-phone\/[^/]+$/,
  /^\/users\/[^/]+\/claims$/,
  /^\/users\/[^/]+\/disable$/,
  /^\/users\/[^/]+\/enable$/,
  /^\/users\/[^/]+\/revoke$/,
  /^\/users\/[^/]+$/,
];

function isAllowedPath(path: string): boolean {
  if (EXACT_PATHS.has(path)) return true;
  return PARAM_PATTERNS.some((p) => p.test(path));
}

export async function POST(request: NextRequest) {
  try {
    const { path, method, body, skipContentType } = await request.json();

    if (!path || typeof path !== 'string') {
      return NextResponse.json({ error: 'Missing path' }, { status: 400 });
    }

    const pathWithoutQuery = path.split('?')[0];
    if (!isAllowedPath(pathWithoutQuery)) {
      return NextResponse.json({ error: 'Path not allowed' }, { status: 400 });
    }

    const res = await callService(path, {
      method: method || 'GET',
      body,
      skipContentType,
    });

    if (res.status === 204) {
      return new NextResponse(null, { status: 204 });
    }

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Service unavailable';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
