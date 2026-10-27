'use client';
/**
 * Main-thread proxy for the engine worker. Every PdfEngine public method is
 * available as an async function with the same signature.
 */
import * as Comlink from 'comlink';
import type { PdfEngine } from '@/lib/pdf/engine';
import type { EngineWorkerApi } from '@/workers/engine.worker';

type AnyFn = (...args: never[]) => unknown;
type MethodKeys = { [K in keyof PdfEngine]: PdfEngine[K] extends AnyFn ? K : never }[keyof PdfEngine];

export type EngineClient = {
  [K in MethodKeys]: PdfEngine[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

let worker: Worker | null = null;
let remote: Comlink.Remote<EngineWorkerApi> | null = null;
let client: EngineClient | null = null;

export function getEngine(): EngineClient {
  if (client) return client;
  worker = new Worker(new URL('../../workers/engine.worker.ts', import.meta.url), { type: 'module' });
  remote = Comlink.wrap<EngineWorkerApi>(worker);
  client = new Proxy({} as EngineClient, {
    get(_t, method: string) {
      return (...args: unknown[]) => remote!.call(method, args);
    },
  });
  return client;
}

export function resetEngine() {
  worker?.terminate();
  worker = null;
  remote = null;
  client = null;
}
