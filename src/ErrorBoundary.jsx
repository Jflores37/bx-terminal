import React from 'react';
import { AlertCircle } from 'lucide-react';

// After a deploy, an open tab still references the old hashed chunks; loading one fails.
// Reload once to pick up the new build; the timestamp guard stops a reload loop.
const RELOAD_KEY = 'bx_chunk_reload_at';
const CHUNK_ERR = /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|Loading (CSS )?chunk|Unable to preload CSS/i;

export function isChunkLoadError(err) {
  return CHUNK_ERR.test(String(err?.message || err || ''));
}

// Set once a reload is under way. A preloadError we swallowed makes React.lazy throw a plain
// TypeError that isChunkLoadError can't match, so the boundary checks this to avoid flashing
// "SOMETHING BROKE" while the page is already reloading.
let reloadStarted = false;

// Returns true if a reload was started.
export function reloadOnceForStaleChunk() {
  if (reloadStarted) return true;
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // no storage -> can't guard against a loop, so don't auto-reload
  }
  reloadStarted = true;
  window.location.reload();
  return true;
}

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, reloading: false };
  }

  static getDerivedStateFromError(error) {
    return { error, reloading: reloadStarted };
  }

  componentDidCatch(error, info) {
    console.error('UI error:', error, info?.componentStack);
    if (isChunkLoadError(error) && reloadOnceForStaleChunk()) this.setState({ reloading: true });
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="flex-1 min-h-[50vh] w-full bg-zinc-950 text-red-400 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <AlertCircle className="w-6 h-6" />
        <span className="text-xs tracking-[0.3em]">{reloading ? 'UPDATING TO THE LATEST VERSION…' : isChunkLoadError(error) ? 'A NEW VERSION IS AVAILABLE' : 'SOMETHING BROKE'}</span>
        {!reloading && (
          <button onClick={() => window.location.reload()}
            className="mt-2 px-4 py-2 border border-zinc-800 text-zinc-300 text-[10px] tracking-wider active:border-emerald-500 md:hover:border-emerald-500">
            RELOAD
          </button>
        )}
      </div>
    );
  }
}
