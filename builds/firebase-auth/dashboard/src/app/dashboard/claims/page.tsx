'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { callProxy, extractError } from '@/lib/service';
import { JsonPanel } from '@/components/json-panel';

const PRESETS = [
  { label: 'Admin', value: '{"admin": true}' },
  { label: 'Beta Tier', value: '{"tier": "beta"}' },
  { label: 'Viewer', value: '{"role": "viewer"}' },
];

export default function ClaimsPage() {
  const { user } = useAuth();
  const [uid, setUid] = useState(user?.uid || '');
  const [currentClaims, setCurrentClaims] = useState<unknown>(null);
  const [claimsText, setClaimsText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{
    data: unknown;
    status: 'success' | 'error' | 'info';
  } | null>(null);

  async function loadClaims() {
    if (!uid.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { data, ok } = await callProxy(
        `/users/${encodeURIComponent(uid.trim())}`
      );
      if (!ok) throw new Error(extractError(data));
      const claims =
        (data as { customClaims?: Record<string, unknown> }).customClaims ||
        {};
      setCurrentClaims(claims);
      setClaimsText(JSON.stringify(claims, null, 2));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }

  async function handleSetClaims(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    try {
      const claims = JSON.parse(claimsText);
      const { data, ok } = await callProxy(
        `/users/${encodeURIComponent(uid.trim())}/claims`,
        'PUT',
        { claims }
      );
      if (!ok) throw new Error(extractError(data));
      setResult({ data, status: 'success' });
      loadClaims();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError('Invalid JSON');
      } else {
        setError(
          err instanceof Error ? err.message : 'Failed to set claims'
        );
      }
    }
  }

  async function handleClearClaims() {
    setError('');
    setResult(null);
    try {
      const { ok, data } = await callProxy(
        `/users/${encodeURIComponent(uid.trim())}/claims`,
        'DELETE',
        undefined,
        { skipContentType: true }
      );
      if (!ok) throw new Error(extractError(data));
      setResult({ data: { cleared: true }, status: 'info' });
      setCurrentClaims({});
      setClaimsText('{}');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to clear claims'
      );
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Custom Claims</h1>

      <div className="flex gap-2">
        <input
          type="text"
          value={uid}
          onChange={(e) => setUid(e.target.value)}
          placeholder="User UID"
          className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none font-mono"
        />
        <button
          onClick={loadClaims}
          disabled={loading || !uid.trim()}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer disabled:opacity-50"
        >
          {loading ? 'Loading...' : 'Load User'}
        </button>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {currentClaims !== null && currentClaims !== undefined && (
        <JsonPanel title="Current Claims" data={currentClaims} status="info" />
      )}

      {currentClaims !== null && currentClaims !== undefined && (
        <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
          <h2 className="text-sm font-medium">Edit Claims</h2>

          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => setClaimsText(p.value)}
                className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors cursor-pointer"
              >
                {p.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleSetClaims} className="space-y-2">
            <textarea
              value={claimsText}
              onChange={(e) => setClaimsText(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none font-mono text-xs resize-none"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer"
              >
                Set Claims
              </button>
              <button
                type="button"
                onClick={handleClearClaims}
                className="px-4 py-1.5 text-sm bg-red-600/80 hover:bg-red-500/80 rounded transition-colors cursor-pointer"
              >
                Clear All
              </button>
            </div>
          </form>
        </div>
      )}

      {result && (
        <JsonPanel title="Result" data={result.data} status={result.status} />
      )}
    </div>
  );
}
