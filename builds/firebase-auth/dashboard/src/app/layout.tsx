import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Firebase Auth Dashboard',
  description: 'Demo dashboard for the Firebase Auth verification service',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        <AuthProvider>
          <nav className="border-b border-gray-800 px-6 py-3 flex items-center justify-between">
            <span className="font-semibold text-sm tracking-wide">
              Firebase Auth Demo
            </span>
          </nav>
          <main className="max-w-4xl mx-auto px-6 py-8">{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
