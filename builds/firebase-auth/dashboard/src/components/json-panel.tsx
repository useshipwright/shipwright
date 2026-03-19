interface JsonPanelProps {
  title: string;
  data: unknown;
  status?: 'success' | 'error' | 'info';
  error?: string;
}

const STATUS_COLORS = {
  success: 'bg-green-500',
  error: 'bg-red-500',
  info: 'bg-blue-500',
};

export function JsonPanel({ title, data, status = 'info', error }: JsonPanelProps) {
  if (error) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-red-500" />
          <h3 className="text-sm font-medium">{title}</h3>
        </div>
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded p-4 space-y-2">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${STATUS_COLORS[status]}`} />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <pre className="text-xs bg-gray-950 p-3 rounded overflow-auto max-h-80">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
