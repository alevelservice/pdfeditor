'use client';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';

// The editor relies on browser-only APIs (Workers, canvas, IndexedDB).
const Editor = dynamic(() => import('@/components/editor/Editor'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-slate-500">Loading editor…</div>,
});

export default function EditorPage() {
  const params = useParams<{ id: string }>();
  return <Editor draftId={params.id} />;
}
