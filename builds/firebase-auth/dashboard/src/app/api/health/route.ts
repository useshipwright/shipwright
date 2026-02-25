import { callService } from '@/lib/api';
import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const res = await callService('/health');
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Service unreachable' },
      { status: 502 }
    );
  }
}
