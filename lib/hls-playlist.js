// Розбір списків відтворення HLS (RFC 8216).

export function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[2];
    attrs[m[1]] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

function lines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const resolve = (uri, base) => new URL(uri, base).href;

export function isPlaylist(text) {
  return text.trimStart().startsWith("#EXTM3U");
}

export function isMaster(text) {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

/**
 * Головний список: варіанти якості та окремі звукові доріжки.
 */
export function parseMaster(text, baseUrl) {
  const variants = [];
  const audio = [];
  let pending = null;
  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttributes(line.slice(18));
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) {
        audio.push({
          groupId: a["GROUP-ID"] || "",
          name: a.NAME || a.LANGUAGE || "",
          language: a.LANGUAGE || "",
          isDefault: a.DEFAULT === "YES",
          url: resolve(a.URI, baseUrl),
        });
      }
    } else if (!line.startsWith("#") && pending) {
      const [w, h] = (pending.RESOLUTION || "").split("x").map(Number);
      variants.push({
        url: resolve(line, baseUrl),
        bandwidth: Number(pending["AVERAGE-BANDWIDTH"] || pending.BANDWIDTH) || 0,
        width: w || 0,
        height: h || 0,
        codecs: pending.CODECS || "",
        audioGroup: pending.AUDIO || "",
      });
      pending = null;
    }
  }
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return { variants, audio };
}

function parseByteRange(value, previousEnd) {
  const [len, off] = value.split("@");
  const length = Number(len);
  const offset = off !== undefined ? Number(off) : previousEnd;
  return { offset, length };
}

function sequenceIv(sequence) {
  const iv = new Uint8Array(16);
  let n = BigInt(sequence);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

export function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, "").padStart(32, "0");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Список сегментів.
 * Кожен сегмент: { url, duration, range?, key: null | { uri, iv } }.
 * `unsupported` — метод шифрування, який розширення не обробляє (DRM).
 */
export function parseMedia(text, baseUrl) {
  const segments = [];
  let sequence = 0;
  let duration = 0;
  let key = null;
  let unsupported = null;
  let map = null;
  let range = null;
  const lastEnd = new Map();
  let endList = false;

  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      sequence = Number(line.slice(22)) || 0;
    } else if (line.startsWith("#EXTINF:")) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      range = line.slice(17);
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(11));
      const method = a.METHOD || "NONE";
      const format = (a.KEYFORMAT || "identity").toLowerCase();
      if (method === "NONE") key = null;
      else if (method === "AES-128" && format === "identity" && a.URI) {
        key = { uri: resolve(a.URI, baseUrl), iv: a.IV ? hexToBytes(a.IV) : null };
      } else {
        unsupported = method;
        key = null;
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) {
        map = { url: resolve(a.URI, baseUrl) };
        if (a.BYTERANGE) map.range = parseByteRange(a.BYTERANGE, 0);
      }
    } else if (line === "#EXT-X-ENDLIST") {
      endList = true;
    } else if (!line.startsWith("#")) {
      const url = resolve(line, baseUrl);
      const segment = { url, duration, key: null };
      if (range) {
        segment.range = parseByteRange(range, lastEnd.get(url) || 0);
        lastEnd.set(url, segment.range.offset + segment.range.length);
        range = null;
      }
      if (key) segment.key = { uri: key.uri, iv: key.iv || sequenceIv(sequence) };
      segments.push(segment);
      sequence += 1;
      duration = 0;
    }
  }

  return {
    segments,
    map,
    endList,
    unsupported,
    duration: segments.reduce((sum, s) => sum + s.duration, 0),
  };
}

/** Розширення файлу для зібраного потоку. */
export function outputExtension(playlist, isAudio = false) {
  if (playlist.map) return isAudio ? "m4a" : "mp4";
  const first = playlist.segments[0]?.url;
  if (!first) return "ts";
  const ext = (new URL(first).pathname.split(".").pop() || "").toLowerCase();
  if (["aac", "mp3", "ac3", "ec3"].includes(ext)) return ext;
  return "ts";
}
