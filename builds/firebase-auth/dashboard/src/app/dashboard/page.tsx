'use client';

import { useAuth } from '@/lib/auth-context';
import { HealthIndicator } from '@/components/health-indicator';
import { UserProfile } from '@/components/user-profile';
import Link from 'next/link';

export default function DashboardPage() {
  const { user, getIdToken } = useAuth();

  if (!user) return null;

  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">Dashboard</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Service Health
        </h2>
        <HealthIndicator />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Token Verification
        </h2>
        <UserProfile user={user} getIdToken={getIdToken} />
      </section>

      <section>
        <Link
          href="/dashboard/batch"
          className="inline-block text-sm text-blue-400 hover:text-blue-300 transition-colors"
        >
          Batch Verify Demo &rarr;
        </Link>
      </section>
    </div>
  );
}
