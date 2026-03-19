'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { label: 'Overview', href: '/dashboard' },
  { label: 'Users', href: '/dashboard/users' },
  { label: 'Claims', href: '/dashboard/claims' },
  { label: 'Tokens', href: '/dashboard/tokens' },
  { label: 'Email', href: '/dashboard/email' },
];

export function NavTabs() {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard';
    return pathname.startsWith(href);
  }

  return (
    <nav className="flex gap-1 border-b border-gray-800">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={`px-4 py-2 text-sm transition-colors ${
            isActive(tab.href)
              ? 'text-white border-b-2 border-blue-500'
              : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
