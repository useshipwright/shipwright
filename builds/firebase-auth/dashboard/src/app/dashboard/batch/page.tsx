'use client';

import { BatchVerify } from '@/components/batch-verify';
import Link from 'next/link';

export default function BatchPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard"
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          &larr; Back
        </Link>
        <h1 className="text-xl font-bold">Batch Verify</h1>
      </div>
      <p className="text-sm text-gray-400">
        Paste one or more Firebase ID tokens (one per line) to verify them
        against the service in a single batch request.
      </p>
      <BatchVerify />
    </div>
  );
}
