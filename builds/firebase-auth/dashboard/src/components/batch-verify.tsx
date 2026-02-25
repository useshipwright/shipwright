'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';

interface BatchResult {
  token: string;
  valid: boolean;
  uid?: string;
  email?: string;
  error?: string;
  error_code?: string;
}

interface BatchResponse {
  results: BatchResult[];
  summary: {
    total: number;
    valid: number;
    expired: number;
    revoked: number;
    malformed: number;
    invalid: number;
  };
}

export function BatchVerify() {
  const { getIdToken } = useAuth();
  const [tokens, setTokens] = useState('');
  const [result, setResult] = useState<BatchResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);

    const tokenList = tokens
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);

    if (tokenList.length === 0) {
      setError('Enter at least one token');
      setLoading(false);
      return;
    }

    if (tokenList.length > 25) {
      setError('Maximum 25 tokens per batch');
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/batch-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens: tokenList }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch verify failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleInsertMyToken() {
    const token = await getIdToken();
    if (token) {
      setTokens((prev) => (prev ? prev + '\n' + token : token));
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleInsertMyToken}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
          >
            Insert my token
          </button>
        </div>
        <textarea
          value={tokens}
          onChange={(e) => setTokens(e.target.value)}
          placeholder="Paste tokens here, one per line..."
          rows={6}
          className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs font-mono focus:outline-none focus:border-blue-500 resize-y"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded transition-colors cursor-pointer"
        >
          {loading ? 'Verifying...' : 'Verify Batch'}
        </button>
      </form>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {result && (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="bg-gray-900 border border-gray-800 rounded p-3">
              <div className="text-lg font-bold text-green-400">
                {result.summary.valid}
              </div>
              <div className="text-xs text-gray-400">Valid</div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded p-3">
              <div className="text-lg font-bold text-red-400">
                {result.summary.total - result.summary.valid}
              </div>
              <div className="text-xs text-gray-400">Invalid</div>
            </div>
            <div className="bg-gray-900 border border-gray-800 rounded p-3">
              <div className="text-lg font-bold">{result.summary.total}</div>
              <div className="text-xs text-gray-400">Total</div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-400 border-b border-gray-800">
                  <th className="pb-2 pr-4">#</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">UID</th>
                  <th className="pb-2 pr-4">Email</th>
                  <th className="pb-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr key={i} className="border-b border-gray-900">
                    <td className="py-1.5 pr-4 text-gray-500">{i + 1}</td>
                    <td className="py-1.5 pr-4">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          r.valid ? 'bg-green-500' : 'bg-red-500'
                        }`}
                      />
                    </td>
                    <td className="py-1.5 pr-4 font-mono">
                      {r.uid ? r.uid.slice(0, 12) + '...' : '-'}
                    </td>
                    <td className="py-1.5 pr-4">{r.email || '-'}</td>
                    <td className="py-1.5 text-red-400">
                      {r.error_code || ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
