'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { callProxy, extractError } from '@/lib/service';

function ActionCard({
  title,
  path,
  buildBody,
  defaultEmail,
}: {
  title: string;
  path: string;
  buildBody: (email: string) => unknown;
  defaultEmail: string;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setLink('');
    try {
      const { data, ok } = await callProxy(path, 'POST', buildBody(email));
      if (!ok) throw new Error(extractError(data));
      setLink((data as { link: string }).link);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate link');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <form onSubmit={handleGenerate} className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email address"
          className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading || !email}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer disabled:opacity-50"
        >
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {link && (
        <div className="space-y-1">
          <p className="text-xs text-gray-400">Generated link:</p>
          <p className="text-xs font-mono bg-gray-950 p-2 rounded break-all select-all">
            {link}
          </p>
        </div>
      )}
    </div>
  );
}

export default function EmailPage() {
  const { user } = useAuth();
  const defaultEmail = user?.email || '';

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Email Actions</h1>

      <ActionCard
        title="Password Reset"
        path="/email-actions/password-reset"
        buildBody={(email) => ({ email })}
        defaultEmail={defaultEmail}
      />

      <ActionCard
        title="Email Verification"
        path="/email-actions/verification"
        buildBody={(email) => ({ email })}
        defaultEmail={defaultEmail}
      />

      <ActionCard
        title="Sign-In Link"
        path="/email-actions/sign-in"
        buildBody={(email) => ({
          email,
          actionCodeSettings: {
            url: typeof window !== 'undefined' ? window.location.origin : '',
            handleCodeInApp: true,
          },
        })}
        defaultEmail={defaultEmail}
      />
    </div>
  );
}
