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
      <h1 className="text-xl font-bold">Overview</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Service Health
        </h2>
        <HealthIndicator />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Your Account
        </h2>
        <div className="bg-gray-900 border border-gray-800 rounded p-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-gray-400">UID</dt>
            <dd className="font-mono text-xs">{user.uid}</dd>
            <dt className="text-gray-400">Email</dt>
            <dd>{user.email || '-'}</dd>
            <dt className="text-gray-400">Display Name</dt>
            <dd>{user.displayName || '-'}</dd>
            <dt className="text-gray-400">Email Verified</dt>
            <dd>{user.emailVerified ? 'Yes' : 'No'}</dd>
          </dl>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Token Verification
        </h2>
        <UserProfile user={user} getIdToken={getIdToken} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <Link
            href="/dashboard/users"
            className="block p-3 bg-gray-900 border border-gray-800 rounded hover:border-gray-700 transition-colors"
          >
            <span className="text-sm font-medium">Manage Users</span>
            <p className="text-xs text-gray-400 mt-1">
              Search, create, and manage user accounts
            </p>
          </Link>
          <Link
            href="/dashboard/claims"
            className="block p-3 bg-gray-900 border border-gray-800 rounded hover:border-gray-700 transition-colors"
          >
            <span className="text-sm font-medium">Custom Claims</span>
            <p className="text-xs text-gray-400 mt-1">
              Set roles and permissions on user accounts
            </p>
          </Link>
          <Link
            href="/dashboard/tokens"
            className="block p-3 bg-gray-900 border border-gray-800 rounded hover:border-gray-700 transition-colors"
          >
            <span className="text-sm font-medium">Tokens & Sessions</span>
            <p className="text-xs text-gray-400 mt-1">
              Verify tokens, manage sessions, mint custom tokens
            </p>
          </Link>
          <Link
            href="/dashboard/email"
            className="block p-3 bg-gray-900 border border-gray-800 rounded hover:border-gray-700 transition-colors"
          >
            <span className="text-sm font-medium">Email Actions</span>
            <p className="text-xs text-gray-400 mt-1">
              Generate password reset and verification links
            </p>
          </Link>
        </div>
      </section>
    </div>
  );
}
