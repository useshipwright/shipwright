'use client';

import { useState } from 'react';
import type { User } from 'firebase/auth';

interface VerifyResult {
  uid: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  custom_claims?: Record<string, unknown>;
  token_metadata?: {
    auth_time: string;
    issued_at: string;
    expires_at: string;
    sign_in_provider: string;
  };
}

interface UserLookupResult {
  uid: string;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  photo_url: string | null;
  disabled: boolean;
  metadata?: {
    creation_time: string;
    last_sign_in_time: string;
  };
  provider_data?: Array<{ provider_id: string; uid: string }>;
}

export function UserProfile({
  user,
  getIdToken,
}: {
  user: User;
  getIdToken: () => Promise<string | null>;
}) {
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [lookupResult, setLookupResult] = useState<UserLookupResult | null>(null);
  const [verifyError, setVerifyError] = useState('');
  const [lookupError, setLookupError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleVerify() {
    setLoading(true);
    setVerifyError('');
    setVerifyResult(null);
    try {
      const token = await getIdToken();
      if (!token) throw new Error('No token available');

      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setVerifyResult(data);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleLookup() {
    setLookupError('');
    setLookupResult(null);
    try {
      const res = await fetch(`/api/user-lookup/${encodeURIComponent(user.uid)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setLookupResult(data);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : 'Lookup failed');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        <button
          onClick={handleVerify}
          disabled={loading}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded transition-colors cursor-pointer"
        >
          {loading ? 'Verifying...' : 'Verify My Token'}
        </button>
        <button
          onClick={handleLookup}
          className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors cursor-pointer"
        >
          User Lookup
        </button>
      </div>

      {verifyError && (
        <p className="text-xs text-red-400">{verifyError}</p>
      )}

      {verifyResult && (
        <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
          <h3 className="text-sm font-medium text-green-400">Token Verified</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-gray-400">UID</dt>
            <dd className="font-mono">{verifyResult.uid}</dd>
            <dt className="text-gray-400">Email</dt>
            <dd>{verifyResult.email}</dd>
            <dt className="text-gray-400">Verified</dt>
            <dd>{verifyResult.email_verified ? 'Yes' : 'No'}</dd>
            {verifyResult.name && (
              <>
                <dt className="text-gray-400">Name</dt>
                <dd>{verifyResult.name}</dd>
              </>
            )}
            {verifyResult.token_metadata && (
              <>
                <dt className="text-gray-400">Provider</dt>
                <dd>{verifyResult.token_metadata.sign_in_provider}</dd>
                <dt className="text-gray-400">Issued</dt>
                <dd>{verifyResult.token_metadata.issued_at}</dd>
                <dt className="text-gray-400">Expires</dt>
                <dd>{verifyResult.token_metadata.expires_at}</dd>
              </>
            )}
          </dl>
          {verifyResult.custom_claims &&
            Object.keys(verifyResult.custom_claims).length > 0 && (
              <div>
                <h4 className="text-xs text-gray-400 mb-1">Custom Claims</h4>
                <pre className="text-xs bg-gray-950 p-2 rounded overflow-auto">
                  {JSON.stringify(verifyResult.custom_claims, null, 2)}
                </pre>
              </div>
            )}
        </div>
      )}

      {lookupError && (
        <p className="text-xs text-red-400">{lookupError}</p>
      )}

      {lookupResult && (
        <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
          <h3 className="text-sm font-medium text-blue-400">User Record</h3>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-gray-400">UID</dt>
            <dd className="font-mono">{lookupResult.uid}</dd>
            <dt className="text-gray-400">Email</dt>
            <dd>{lookupResult.email || '-'}</dd>
            <dt className="text-gray-400">Email Verified</dt>
            <dd>{lookupResult.email_verified ? 'Yes' : 'No'}</dd>
            {lookupResult.display_name && (
              <>
                <dt className="text-gray-400">Display Name</dt>
                <dd>{lookupResult.display_name}</dd>
              </>
            )}
            <dt className="text-gray-400">Disabled</dt>
            <dd>{lookupResult.disabled ? 'Yes' : 'No'}</dd>
            {lookupResult.metadata && (
              <>
                <dt className="text-gray-400">Created</dt>
                <dd>{lookupResult.metadata.creation_time}</dd>
                <dt className="text-gray-400">Last Sign In</dt>
                <dd>{lookupResult.metadata.last_sign_in_time}</dd>
              </>
            )}
          </dl>
          {lookupResult.provider_data && lookupResult.provider_data.length > 0 && (
            <div>
              <h4 className="text-xs text-gray-400 mb-1">Providers</h4>
              <div className="flex gap-2">
                {lookupResult.provider_data.map((p) => (
                  <span
                    key={p.provider_id}
                    className="text-xs px-2 py-0.5 bg-gray-800 rounded"
                  >
                    {p.provider_id}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
