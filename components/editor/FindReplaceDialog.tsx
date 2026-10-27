'use client';
import { useState } from 'react';
import { useEditor } from '@/store/editorStore';
import type { SearchOptions } from '@/lib/pdf/types';

export default function FindReplaceDialog({ onNavigate }: { onNavigate: (index: number) => void }) {
  const s = useEditor();
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [opts, setOpts] = useState<Omit<SearchOptions, 'query'>>({ regex: false, matchCase: false, wholeWord: false });
  const [searching, setSearching] = useState(false);
  const hits = s.searchHits;

  const search = async () => {
    if (!query) return;
    setSearching(true);
    try {
      const h = await s.engine().search({ query, ...opts });
      s.set({ searchHits: h, activeHit: h.length ? 0 : -1 });
      if (h.length) onNavigate(h[0].pageIndex);
    } catch (e) {
      s.toast('error', (e as Error).message);
    } finally {
      setSearching(false);
    }
  };
  const go = (i: number) => {
    if (!hits.length) return;
    const k = (i + hits.length) % hits.length;
    s.set({ activeHit: k });
    onNavigate(hits[k].pageIndex);
  };

  return (
    <div className="fixed right-4 top-28 z-50 w-96 rounded-lg border border-slate-200 bg-white p-3 shadow-2xl dark:border-slate-700 dark:bg-slate-900" data-testid="find-dialog">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">Find &amp; Replace</h3>
        <button className="tool" onClick={() => { s.closeDialog(); s.set({ searchHits: [], activeHit: -1 }); }}>✕</button>
      </div>
      <div className="space-y-2">
        <input autoFocus className="input" placeholder="Find" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (hits.length ? go(s.activeHit + 1) : search())} data-testid="find-input" />
        <input className="input" placeholder="Replace with" value={replacement} onChange={(e) => setReplacement(e.target.value)} data-testid="replace-input" />
        <div className="flex flex-wrap gap-3 text-xs">
          {(['matchCase', 'wholeWord', 'regex'] as const).map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input type="checkbox" checked={!!opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />
              {{ matchCase: 'Match case', wholeWord: 'Whole word', regex: 'Regex' }[k]}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          <button className="btn" onClick={search} disabled={searching} data-testid="find-button">{searching ? 'Searching…' : 'Find'}</button>
          <button className="btn" onClick={() => go(s.activeHit - 1)} disabled={!hits.length}>◀</button>
          <button className="btn" onClick={() => go(s.activeHit + 1)} disabled={!hits.length}>▶</button>
          <button
            className="btn"
            disabled={s.activeHit < 0}
            onClick={async () => {
              const hit = hits[s.activeHit];
              await s.act('Replace', (e) => e.replaceHit(hit, replacement));
              await search();
            }}
          >
            Replace
          </button>
          <button
            className="btn btn-primary"
            disabled={!query}
            data-testid="replace-all"
            onClick={async () => {
              const r = await s.act('Replace all', (e) => e.replaceAll({ query, ...opts }, replacement));
              if (r) {
                s.toast('success', `Replaced ${r.count} occurrence(s) in the content streams.`);
                r.warnings.slice(0, 3).forEach((w) => s.toast('warning', w));
              }
              s.set({ searchHits: [], activeHit: -1 });
            }}
          >
            Replace all
          </button>
        </div>
        <div className="text-xs text-slate-500" data-testid="find-count">
          {hits.length ? `${s.activeHit + 1} of ${hits.length} matches` : query && !searching ? 'No matches yet — press Find' : ''}
        </div>
        {hits.length > 0 && (
          <ul className="max-h-48 overflow-y-auto text-xs">
            {hits.slice(0, 200).map((h, i) => (
              <li key={i}>
                <button className={`w-full truncate rounded px-1 py-0.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${i === s.activeHit ? 'bg-amber-100 dark:bg-amber-900/40' : ''}`} onClick={() => go(i)}>
                  <span className="text-slate-400">p.{h.pageIndex + 1}</span> {h.context.slice(Math.max(0, h.start - 20), h.start)}
                  <b>{h.text}</b>
                  {h.context.slice(h.end, h.end + 30)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
