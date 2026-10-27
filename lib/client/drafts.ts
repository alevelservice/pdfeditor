'use client';
/**
 * Draft persistence in IndexedDB (idb-keyval). Each draft stores the latest
 * saved bytes plus the original file so "revert" is always possible.
 */
import { createStore, del, get, keys, set } from 'idb-keyval';

export interface DraftMeta {
  id: string;
  name: string;
  size: number;
  pages: number;
  updated: number;
}

interface DraftRecord extends DraftMeta {
  bytes: Uint8Array;
  original?: Uint8Array;
}

const store = typeof indexedDB !== 'undefined' ? createStore('pdf-editor', 'drafts') : undefined;

export function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveDraft(id: string, name: string, bytes: Uint8Array, pages: number, original?: Uint8Array): Promise<void> {
  if (!store) return;
  const prev = (await get<DraftRecord>(id, store)) ?? undefined;
  const rec: DraftRecord = { id, name, size: bytes.length, pages, updated: Date.now(), bytes, original: original ?? prev?.original ?? bytes };
  await set(id, rec, store);
}

export async function loadDraft(id: string): Promise<DraftRecord | undefined> {
  if (!store) return undefined;
  return get<DraftRecord>(id, store);
}

export async function listDrafts(): Promise<DraftMeta[]> {
  if (!store) return [];
  const ids = await keys(store);
  const out: DraftMeta[] = [];
  for (const k of ids) {
    const r = await get<DraftRecord>(k, store);
    if (r) out.push({ id: r.id, name: r.name, size: r.size, pages: r.pages, updated: r.updated });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export async function deleteDraft(id: string): Promise<void> {
  if (store) await del(id, store);
}
