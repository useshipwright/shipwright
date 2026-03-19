'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { useAuth } from '@/lib/auth-context';
import { getFirebaseAuth } from '@/lib/firebase';
import { NavTabs } from '@/components/nav-tabs';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-sm text-gray-400">
          Signed in as <span className="text-gray-200">{user.email}</span>
        </div>
        <button
          onClick={() => signOut(getFirebaseAuth())}
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
        >
          Sign out
        </button>
      </div>
      <NavTabs />
      {children}
    </div>
  );
}
