// Паралельне завантаження сегментів HLS із записом у правильному порядку.

import { decryptSegment, importKey } from "./aes.js";

export class DownloadError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });

/** Завантажує ресурс (з діапазоном байтів, якщо треба) з повторами. */
export async function fetchBytes(url, { range, signal, retries = 4, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal?.throwIfAborted();
    try {
      const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
      const res = await fetchImpl(url, { headers, signal, credentials: "include" });
      if (!res.ok) throw new DownloadError("http", { status: res.status, url });
      let bytes = new Uint8Array(await res.arrayBuffer());
      // Сервер проігнорував Range і віддав увесь файл.
      if (range && res.status === 200 && bytes.byteLength > range.length) {
        bytes = bytes.subarray(range.offset, range.offset + range.length);
      }
      return bytes;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      lastError = error;
      // 4xx, крім 408 і 429, повтор не виправить.
      const status = error?.detail?.status;
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      if (attempt < retries) await sleep(800 * 2 ** attempt, signal);
    }
  }
  throw lastError instanceof DownloadError ? lastError : new DownloadError("network", { url, message: String(lastError) });
}

/**
 * Завантажує всі сегменти списку й передає їх у `write` строго по порядку.
 * @param {object} o
 * @param {{segments: Array, map: object | null}} o.playlist
 * @param {(chunk: Uint8Array) => Promise<void>} o.write
 * @param {(p: {done: number, total: number, bytes: number}) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function downloadPlaylist({ playlist, write, onProgress, signal: outer, concurrency = 4, fetchImpl = fetch }) {
  // Власний сигнал: якщо один сегмент остаточно не вдався, зупиняємо решту.
  const inner = new AbortController();
  const stop = () => inner.abort(outer.reason);
  if (outer?.aborted) stop();
  outer?.addEventListener("abort", stop, { once: true });

  try {
    return await run(inner.signal);
  } catch (error) {
    if (!inner.signal.aborted) inner.abort(error);
    throw outer?.aborted ? outer.reason : error;
  } finally {
    outer?.removeEventListener("abort", stop);
  }

  async function run(signal) {
    const keys = new Map();
    const getKey = (uri) => {
      if (!keys.has(uri)) keys.set(uri, fetchBytes(uri, { signal, fetchImpl }).then(importKey));
      return keys.get(uri);
    };

    if (playlist.map) {
      await write(await fetchBytes(playlist.map.url, { range: playlist.map.range, signal, fetchImpl }));
    }

    const { segments } = playlist;
    const total = segments.length;
    const ready = new Map();
    let next = 0;
    let written = 0;
    let bytes = 0;
    let flushing = Promise.resolve();

    const flush = () => {
      flushing = flushing.then(async () => {
        while (ready.has(written)) {
          const chunk = ready.get(written);
          ready.delete(written);
          await write(chunk);
          written += 1;
          onProgress?.({ done: written, total, bytes });
        }
      });
      return flushing;
    };

    const worker = async () => {
      while (next < total) {
        signal.throwIfAborted();
        const index = next++;
        const segment = segments[index];
        let data = await fetchBytes(segment.url, { range: segment.range, signal, fetchImpl });
        if (segment.key) {
          try {
            data = await decryptSegment(await getKey(segment.key.uri), segment.key.iv, data);
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            throw error instanceof DownloadError ? error : new DownloadError("decrypt", { message: String(error) });
          }
        }
        bytes += data.byteLength;
        ready.set(index, data);
        await flush();
      }
    };

    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
    await flushing;
    return { bytes, segments: total };
  }
}
