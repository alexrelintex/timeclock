// Minimal HTTP helpers over node:http — no web framework dependency.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

export async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error('payload too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req);
  return body ? (JSON.parse(body) as T) : ({} as T);
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendText(res: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  res.end(body);
}

export async function sendFile(res: ServerResponse, path: string, contentType: string): Promise<void> {
  try {
    const buf = await readFile(path);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch {
    sendText(res, 404, 'not found');
  }
}

export interface SseChannel {
  send(event: string, data: unknown): void;
  close(): void;
  onClose(fn: () => void): void;
}

export function openSse(res: ServerResponse): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  let closed = false;
  const closers: (() => void)[] = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const c of closers) c();
  };
  res.on('close', cleanup);
  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      cleanup();
      res.end();
    },
    onClose(fn) {
      closers.push(fn);
    },
  };
}
