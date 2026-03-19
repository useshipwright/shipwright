'use client';

import { useState, useEffect, Fragment } from 'react';
import { callProxy, extractError } from '@/lib/service';

interface UserRecord {
  uid: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  phoneNumber?: string;
  photoURL?: string;
  metadata?: {
    creationTime: string;
    lastSignInTime: string;
  };
  providerData?: Array<{ providerId: string; uid: string }>;
  customClaims?: Record<string, unknown>;
}

type SearchMode = 'uid' | 'email' | 'phone';

export default function UsersPage() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [searchMode, setSearchMode] = useState<SearchMode>('email');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchResult, setIsSearchResult] = useState(false);
  const [prevTokens, setPrevTokens] = useState<(string | undefined)[]>([]);
  const [currentToken, setCurrentToken] = useState<string | undefined>();
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [expandedUid, setExpandedUid] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createName, setCreateName] = useState('');
  const [createError, setCreateError] = useState('');

  async function loadUsers(pageToken?: string) {
    setLoading(true);
    setError('');
    setIsSearchResult(false);
    try {
      const params = new URLSearchParams({ maxResults: '10' });
      if (pageToken) params.set('pageToken', pageToken);
      const { data, ok } = await callProxy(`/users?${params}`);
      if (!ok) throw new Error(extractError(data));
      const result = data as { users: UserRecord[]; pageToken?: string };
      setUsers(result.users || []);
      setCurrentToken(pageToken);
      setNextToken(result.pageToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQuery.trim()) {
      loadUsers();
      return;
    }
    setLoading(true);
    setError('');
    try {
      const paths: Record<SearchMode, string> = {
        uid: `/users/${encodeURIComponent(searchQuery.trim())}`,
        email: `/users/by-email/${encodeURIComponent(searchQuery.trim())}`,
        phone: `/users/by-phone/${encodeURIComponent(searchQuery.trim())}`,
      };
      const { data, ok } = await callProxy(paths[searchMode]);
      if (!ok) throw new Error(extractError(data));
      setUsers([data as UserRecord]);
      setIsSearchResult(true);
      setNextToken(undefined);
      setPrevTokens([]);
      setCurrentToken(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }

  function handleNextPage() {
    if (!nextToken) return;
    setPrevTokens((prev) => [...prev, currentToken]);
    loadUsers(nextToken);
  }

  function handlePrevPage() {
    if (prevTokens.length === 0) return;
    const newStack = [...prevTokens];
    const token = newStack.pop();
    setPrevTokens(newStack);
    loadUsers(token);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError('');
    try {
      const body: Record<string, string> = {};
      if (createEmail) body.email = createEmail;
      if (createPassword) body.password = createPassword;
      if (createName) body.displayName = createName;
      const { data, ok } = await callProxy('/users', 'POST', body);
      if (!ok) throw new Error(extractError(data));
      setShowCreate(false);
      setCreateEmail('');
      setCreatePassword('');
      setCreateName('');
      loadUsers(currentToken);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    }
  }

  async function handleToggle(uid: string, currentlyDisabled: boolean) {
    setActionLoading(uid);
    try {
      const action = currentlyDisabled ? 'enable' : 'disable';
      const { data, ok } = await callProxy(`/users/${encodeURIComponent(uid)}/${action}`, 'POST');
      if (!ok) throw new Error(extractError(data));
      setUsers((prev) =>
        prev.map((u) => (u.uid === uid ? { ...u, disabled: !currentlyDisabled } : u))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDelete(uid: string) {
    setActionLoading(uid);
    try {
      const { ok, data } = await callProxy(`/users/${encodeURIComponent(uid)}`, 'DELETE');
      if (!ok) throw new Error(extractError(data));
      setDeleteConfirm(null);
      setUsers((prev) => prev.filter((u) => u.uid !== uid));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setActionLoading(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Users</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 rounded transition-colors cursor-pointer"
        >
          {showCreate ? 'Cancel' : 'Create User'}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-gray-900 border border-gray-800 rounded p-4 space-y-3">
          <h2 className="text-sm font-medium">New User</h2>
          <div className="grid grid-cols-3 gap-3">
            <input
              type="email"
              placeholder="Email"
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              className="px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
            <input
              type="password"
              placeholder="Password (min 6)"
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
              className="px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
            <input
              type="text"
              placeholder="Display Name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className="px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
            />
          </div>
          {createError && <p className="text-xs text-red-400">{createError}</p>}
          <button
            type="submit"
            className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-500 rounded transition-colors cursor-pointer"
          >
            Create
          </button>
        </form>
      )}

      <form onSubmit={handleSearch} className="flex gap-2">
        <select
          value={searchMode}
          onChange={(e) => setSearchMode(e.target.value as SearchMode)}
          className="px-3 py-1.5 text-sm bg-gray-900 border border-gray-700 rounded focus:border-blue-500 focus:outline-none cursor-pointer"
        >
          <option value="email">Email</option>
          <option value="uid">UID</option>
          <option value="phone">Phone</option>
        </select>
        <input
          type="text"
          placeholder={`Search by ${searchMode}...`}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm bg-gray-950 border border-gray-700 rounded focus:border-blue-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors cursor-pointer disabled:opacity-50"
        >
          Search
        </button>
        {isSearchResult && (
          <button
            type="button"
            onClick={() => { setSearchQuery(''); loadUsers(); }}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors cursor-pointer"
          >
            Clear
          </button>
        )}
      </form>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="bg-gray-900 border border-gray-800 rounded overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs text-gray-400 uppercase tracking-wide">
              <th className="px-4 py-2">UID</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No users found
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <Fragment key={user.uid}>
                  <tr
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
                    onClick={() => setExpandedUid(expandedUid === user.uid ? null : user.uid)}
                  >
                    <td className="px-4 py-2 font-mono text-xs">
                      {user.uid.slice(0, 12)}...
                    </td>
                    <td className="px-4 py-2">{user.email || '-'}</td>
                    <td className="px-4 py-2">{user.displayName || '-'}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        {user.emailVerified && (
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500" title="Verified" />
                        )}
                        {user.disabled && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-400">
                            Disabled
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleToggle(user.uid, !!user.disabled)}
                          disabled={actionLoading === user.uid}
                          className="text-xs text-gray-400 hover:text-gray-200 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          {user.disabled ? 'Enable' : 'Disable'}
                        </button>
                        {deleteConfirm === user.uid ? (
                          <span className="flex items-center gap-1 text-xs">
                            <span className="text-red-400">Sure?</span>
                            <button
                              onClick={() => handleDelete(user.uid)}
                              disabled={actionLoading === user.uid}
                              className="text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="text-gray-400 hover:text-gray-200 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(user.uid)}
                            className="text-xs text-red-400/70 hover:text-red-400 transition-colors cursor-pointer"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {expandedUid === user.uid && (
                    <tr className="border-b border-gray-800/50 bg-gray-800/20">
                      <td colSpan={5} className="px-4 py-3">
                        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                          <dt className="text-gray-400">UID</dt>
                          <dd className="font-mono">{user.uid}</dd>
                          <dt className="text-gray-400">Email</dt>
                          <dd>{user.email || '-'}</dd>
                          <dt className="text-gray-400">Email Verified</dt>
                          <dd>{user.emailVerified ? 'Yes' : 'No'}</dd>
                          <dt className="text-gray-400">Display Name</dt>
                          <dd>{user.displayName || '-'}</dd>
                          <dt className="text-gray-400">Phone</dt>
                          <dd>{user.phoneNumber || '-'}</dd>
                          <dt className="text-gray-400">Disabled</dt>
                          <dd>{user.disabled ? 'Yes' : 'No'}</dd>
                          {user.metadata && (
                            <>
                              <dt className="text-gray-400">Created</dt>
                              <dd>{user.metadata.creationTime}</dd>
                              <dt className="text-gray-400">Last Sign In</dt>
                              <dd>{user.metadata.lastSignInTime || '-'}</dd>
                            </>
                          )}
                          {user.providerData && user.providerData.length > 0 && (
                            <>
                              <dt className="text-gray-400">Providers</dt>
                              <dd className="flex gap-1">
                                {user.providerData.map((p) => (
                                  <span
                                    key={p.providerId}
                                    className="px-1.5 py-0.5 bg-gray-800 rounded text-[10px]"
                                  >
                                    {p.providerId}
                                  </span>
                                ))}
                              </dd>
                            </>
                          )}
                          {user.customClaims && Object.keys(user.customClaims).length > 0 && (
                            <>
                              <dt className="text-gray-400">Custom Claims</dt>
                              <dd>
                                <pre className="bg-gray-950 p-2 rounded text-[10px]">
                                  {JSON.stringify(user.customClaims, null, 2)}
                                </pre>
                              </dd>
                            </>
                          )}
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {!isSearchResult && (
        <div className="flex items-center justify-between text-sm">
          <button
            onClick={handlePrevPage}
            disabled={prevTokens.length === 0 || loading}
            className="px-3 py-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
          >
            &larr; Previous
          </button>
          <span className="text-gray-500 text-xs">
            Page {prevTokens.length + 1}
          </span>
          <button
            onClick={handleNextPage}
            disabled={!nextToken || loading}
            className="px-3 py-1 text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-default cursor-pointer transition-colors"
          >
            Next &rarr;
          </button>
        </div>
      )}
    </div>
  );
}
