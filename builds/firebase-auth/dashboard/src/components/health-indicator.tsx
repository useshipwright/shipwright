'use client';

import { useEffect, useState } from 'react';

interface HealthData {
  status: string;
  firebase_initialized?: boolean;
  uptime_seconds?: number;
}

export function HealthIndicator() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [error, setError] = useState(false);

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        setHealth(await res.json());
        setError(false);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
  }

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 15000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-900 border border-gray-800 rounded">
        <span className="w-2 h-2 rounded-full bg-red-500" />
        <span className="text-sm text-red-400">Service unreachable</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-900 border border-gray-800 rounded">
        <span className="w-2 h-2 rounded-full bg-gray-500 animate-pulse" />
        <span className="text-sm text-gray-400">Checking...</span>
      </div>
    );
  }

  const isHealthy = health.status === 'ok';
  const firebaseOk = health.firebase_initialized;

  return (
    <div className="px-4 py-3 bg-gray-900 border border-gray-800 rounded space-y-2">
      <div className="flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${isHealthy ? 'bg-green-500' : 'bg-yellow-500'}`}
        />
        <span className="text-sm">
          {isHealthy ? 'Healthy' : health.status}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs text-gray-400">
        <div>
          Firebase:{' '}
          <span className={firebaseOk ? 'text-green-400' : 'text-red-400'}>
            {firebaseOk ? 'initialized' : 'not initialized'}
          </span>
        </div>
        {health.uptime_seconds != null && (
          <div>
            Uptime: {Math.floor(health.uptime_seconds)}s
          </div>
        )}
      </div>
    </div>
  );
}
