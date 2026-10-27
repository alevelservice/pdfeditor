'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteDraft, listDrafts, newDraftId, saveDraft, type DraftMeta } from '@/lib/client/drafts';
import { getEngine } from '@/lib/client/engineClient';
import { downloadBytes, pickFile } from '@/lib/client/imageUtils';

export default function Home() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftMeta[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listDrafts().then(setDrafts).catch(() => setDrafts([]));
  }, []);
  useEffect(reload, [reload]);

  const openFiles = async (files: File[]) => {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) {
      setError('Please choose a PDF file.');
      return;
    }
    setError(null);
    const id = newDraftId();
    const bytes = new Uint8Array(await pdfs[0].arrayBuffer());
    if (pdfs.length === 1) {
      await saveDraft(id, pdfs[0].name, bytes, 0, bytes);
      router.push(`/editor/${id}`);
      return;
    }
    // Multiple files: merge them into one new document.
    setBusy(`Merging ${pdfs.length} files…`);
    try {
      const e = getEngine();
      await e.open(bytes, { name: 'merged.pdf' });
      const rest = await Promise.all(pdfs.slice(1).map(async (f) => new Uint8Array(await f.arrayBuffer())));
      const info = await e.mergePdfs(rest);
      const merged = await e.save({});
      await saveDraft(id, 'merged.pdf', merged, info.pageCount, merged);
      router.push(`/editor/${id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleTheme = () => {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  };

  return (
    <main className="mx-auto flex min-h-full max-w-4xl flex-col gap-8 px-4 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">PDF Editor</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">Edit the real content of any PDF — text, images, vectors, links, forms and pages. Files never leave your browser.</p>
        </div>
        <button className="btn" onClick={toggleTheme} aria-label="Toggle dark mode">◐ Theme</button>
      </header>

      <section
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          openFiles(Array.from(e.dataTransfer.files));
        }}
        className={`flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed p-12 text-center transition ${dragging ? 'border-brand-500 bg-brand-50 dark:bg-brand-700/20' : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900'}`}
      >
        <div className="text-5xl">📄</div>
        <p className="text-lg font-medium">Drop a PDF here</p>
        <p className="text-sm text-slate-500">Drop several PDFs to merge them.</p>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={async () => openFiles(await pickFile('application/pdf,.pdf'))} data-testid="open-pdf">
            Open PDF
          </button>
          <button className="btn" onClick={async () => openFiles(await pickFile('application/pdf,.pdf', true))}>
            Merge PDFs…
          </button>
        </div>
        {busy && <p className="text-sm text-brand-600">{busy}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Recent drafts</h2>
        {drafts.length === 0 ? (
          <p className="text-sm text-slate-500">No drafts yet. Edits are autosaved in this browser (IndexedDB).</p>
        ) : (
          <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {drafts.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-2 px-4 py-3">
                <button className="min-w-0 flex-1 text-left" onClick={() => router.push(`/editor/${d.id}`)}>
                  <div className="truncate font-medium">{d.name}</div>
                  <div className="text-xs text-slate-500">
                    {(d.size / 1024 / 1024).toFixed(2)} MB · {d.pages ? `${d.pages} pages · ` : ''}
                    {new Date(d.updated).toLocaleString()}
                  </div>
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const { loadDraft } = await import('@/lib/client/drafts');
                    const r = await loadDraft(d.id);
                    if (r) downloadBytes(r.bytes, d.name);
                  }}
                >
                  Download
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    await deleteDraft(d.id);
                    reload();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
