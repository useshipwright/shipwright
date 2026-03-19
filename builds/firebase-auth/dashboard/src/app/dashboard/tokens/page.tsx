'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { callProxy, extractError } from '@/lib/service';
import { JsonPanel } from '@/components/json-panel';

export default function TokensPage() {
  const { user, getIdToken } = useAuth();

  // --- Verify Token ---
  const [verifyToken, setVerifyToken] = useState('');
  const [checkRevoked, setCheckRevoked] = useState(false);
  const [verifyResult, setVerifyResult] = useState<unknown>(null);
  const [verifyError, setVerifyError] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);

  async function fillToken() {
    const token = await getIdToken();
    if (token) setVerifyToken(token);
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setVerifyLoading(true);
    setVerifyError('');
    setVerifyResult(null);
    try {
      const { data, ok } = await callProxy('/verify', 'POST', {
        token: verifyToken,
        checkRevoked,
      });
      if (!ok) throw new Error(extractError(data));
      setVerifyResult(data);
    } catch (err) {
      setVerifyError(
        err instanceof Error ? err.message : 'Verification failed'
      );
    } finally {
      setVerifyLoading(false);
    }
  }

  // --- Sessions ---
  const [expiresIn, setExpiresIn] = useState('3600000');
  const [sessionCookie, setSessionCookie] = useState('');
  const [createSessionError, setCreateSessionError] = useState('');
  const [createSessionLoading, setCreateSessionLoading] = useState(false);

  const [verifyCookieInput, setVerifyCookieInput] = useState('');
  const [verifyCookieResult, setVerifyCookieResult] = useState<unknown>(null);
  const [verifyCookieError, setVerifyCookieError] = useState('');

  async function handleCreateSession() {
    setCreateSessionLoading(true);
    setCreateSessionError('');
    setSessionCookie('');
    try {
      const token = await getIdToken();
      if (!token) throw new Error('No token available');
      const { data, ok } = await callProxy('/sessions', 'POST', {
        idToken: token,
        expiresIn: parseInt(expiresIn, 10),
      });
      if (!ok) throw new Error(extractError(data));
      setSessionCookie(
        (data as { sessionCookie: string }).sessionCookie
      );
    } catch (err) {
      setCreateSessionError(
        err instanceof Error ? err.message : 'Failed to create session'
      );
    } finally {
      setCreateSessionLoading(false);
    }
  }

  async function handleVerifySession(e: React.FormEvent) {
    e.preventDefault();
    setVerifyCookieError('');
    setVerifyCookieResult(null);
    try {
      const { data, ok } = await callProxy('/sessions/verify', 'POST', {
        sessionCookie: verifyCookieInput,
      });
      if (!ok) throw new Error(extractError(data));
      setVerifyCookieResult(data);
    } catch (err) {
      setVerifyCookieError(
        err instanceof Error ? err.message : 'Verification failed'
      );
    }
  }

  // --- Custom Tokens ---
  const [customUid, setCustomUid] = useState(user?.uid || '');
  const [customClaims, setCustomClaims] = useState('');
  const [customToken, setCustomToken] = useState('');
  const [customError, setCustomError] = useState('');
  const [customLoading, setCustomLoading] = useState(false);

  const [revokeUid, setRevokeUid] = useState(user?.uid || '');
  const [revokeResult, setRevokeResult] = useState<unknown>(null);
  const [revokeError, setRevokeError] = useState('');

  async function handleMintToken(e: React.FormEvent) {
    e.preventDefault();
    setCustomLoading(true);
    setCustomError('');
    setCustomToken('');
    try {
      const body: { uid: string; claims?: Record<string, unknown> } = {
        uid: customUid,
      };
      if (customClaims.trim()) {
        body.claims = JSON.parse(customClaims);
      }
      const { data, ok } = await callProxy('/tokens/custom', 'POST', body);
      if (!ok) throw new Error(extractError(data));
      setCustomToken(
        (data as { customToken: string }).customToken
      );
    } catch (err) {
      setCustomError(
        err instanceof Error ? err.message : 'Failed to mint token'
      );
    } finally {
      setCustomLoading(false);
    }
  }

  async function handleRevoke() {
    setRevokeError('');
    setRevokeResult(null);
    try {
      const { data, ok } = await callProxy(
        `/users/${encodeURIComponent(revokeUid)}/revoke`,
        'POST'
      );
      if (!ok) throw new Error(extractError(data));
      setRevokeResult(data);
    } catch (err) {
      setRevokeError(
        err instanceof Error ? err.message : 'Failed to revoke tokens'
      );
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Tokens & Sessions</h1>

      {/* Verify Token */}
      <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
        <h2 className="text-sm font-medium">Verify ID Token</h2>
        <form onSubmit={handleVerify} className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={verifyToken}
              onChange={(e) => setVerifyToken(e.target.value)}
              placeholder="Paste ID token..."
              className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none font-mono text-xs"
            />
            <button
              type="button"
              onClick={fillToken}
              className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors cursor-pointer"
            >
              Fill my token
            </button>
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={checkRevoked}
                onChange={(e) => setCheckRevoked(e.target.checked)}
                className="cursor-pointer"
              />
              Check revoked
            </label>
            <button
              type="submit"
              disabled={verifyLoading || !verifyToken}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer disabled:opacity-50"
            >
              {verifyLoading ? 'Verifying...' : 'Verify'}
            </button>
          </div>
        </form>
        {verifyError && <p className="text-xs text-red-400">{verifyError}</p>}
        {verifyResult !== null && (
          <JsonPanel title="Decoded Token" data={verifyResult} status="success" />
        )}
      </div>

      {/* Session Cookies */}
      <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-4">
        <h2 className="text-sm font-medium">Session Cookies</h2>

        <div className="space-y-2">
          <h3 className="text-xs text-gray-400">Create Session</h3>
          <div className="flex gap-2 items-center">
            <label className="text-xs text-gray-400 whitespace-nowrap">
              Expires in (ms):
            </label>
            <input
              type="number"
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              className="w-32 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleCreateSession}
              disabled={createSessionLoading}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer disabled:opacity-50"
            >
              {createSessionLoading ? 'Creating...' : 'Create'}
            </button>
          </div>
          {createSessionError && (
            <p className="text-xs text-red-400">{createSessionError}</p>
          )}
          {sessionCookie && (
            <div className="space-y-1">
              <p className="text-xs text-gray-400">Session cookie:</p>
              <p className="text-xs font-mono bg-gray-950 p-2 rounded break-all select-all max-h-20 overflow-auto">
                {sessionCookie}
              </p>
            </div>
          )}
        </div>

        <div className="border-t border-gray-800 pt-3 space-y-2">
          <h3 className="text-xs text-gray-400">Verify Session</h3>
          <form onSubmit={handleVerifySession} className="flex gap-2">
            <input
              type="text"
              value={verifyCookieInput}
              onChange={(e) => setVerifyCookieInput(e.target.value)}
              placeholder="Paste session cookie..."
              className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none font-mono text-xs"
            />
            <button
              type="submit"
              disabled={!verifyCookieInput}
              className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors cursor-pointer disabled:opacity-50"
            >
              Verify
            </button>
          </form>
          {verifyCookieError && (
            <p className="text-xs text-red-400">{verifyCookieError}</p>
          )}
          {verifyCookieResult !== null && (
            <JsonPanel
              title="Decoded Session"
              data={verifyCookieResult}
              status="success"
            />
          )}
        </div>
      </div>

      {/* Custom Tokens */}
      <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-4">
        <h2 className="text-sm font-medium">Custom Tokens</h2>

        <form onSubmit={handleMintToken} className="space-y-2">
          <h3 className="text-xs text-gray-400">Mint Custom Token</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={customUid}
              onChange={(e) => setCustomUid(e.target.value)}
              placeholder="UID"
              className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={customLoading || !customUid}
              className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer disabled:opacity-50"
            >
              {customLoading ? 'Minting...' : 'Mint Token'}
            </button>
          </div>
          <textarea
            value={customClaims}
            onChange={(e) => setCustomClaims(e.target.value)}
            placeholder='Optional claims JSON, e.g. {"role": "admin"}'
            rows={2}
            className="w-full px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none font-mono text-xs resize-none"
          />
        </form>
        {customError && <p className="text-xs text-red-400">{customError}</p>}
        {customToken && (
          <div className="space-y-1">
            <p className="text-xs text-gray-400">Custom token:</p>
            <p className="text-xs font-mono bg-gray-950 p-2 rounded break-all select-all max-h-20 overflow-auto">
              {customToken}
            </p>
          </div>
        )}

        <div className="border-t border-gray-800 pt-3 space-y-2">
          <h3 className="text-xs text-gray-400">Revoke Refresh Tokens</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={revokeUid}
              onChange={(e) => setRevokeUid(e.target.value)}
              placeholder="UID"
              className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
            <button
              onClick={handleRevoke}
              disabled={!revokeUid}
              className="px-4 py-1.5 text-sm bg-red-600/80 hover:bg-red-500/80 rounded transition-colors cursor-pointer disabled:opacity-50"
            >
              Revoke
            </button>
          </div>
          {revokeError && (
            <p className="text-xs text-red-400">{revokeError}</p>
          )}
          {revokeResult !== null && (
            <JsonPanel
              title="Revocation Result"
              data={revokeResult}
              status="info"
            />
          )}
        </div>
      </div>
    </div>
  );
}
