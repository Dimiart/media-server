// Розпізнавання медіафайлів за адресою та заголовками відповіді.

const HLS_MIME = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]);

// Шматочки потокового відео: окремо їх зберігати немає сенсу.
const SEGMENT_MIME = new Set(["video/mp2t", "video/iso.segment", "audio/iso.segment"]);
const SEGMENT_EXT = new Set(["ts", "m4s", "m4f", "cmfv", "cmfa"]);

const FILE_EXT = new Set([
  "mp4", "m4v", "webm", "mkv", "mov", "avi", "flv", "3gp", "ogv",
  "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba",
]);

const MIME_EXT = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/x-flv": "flv",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  "audio/webm": "weba",
};

export function extensionOf(url) {
  try {
    const last = new URL(url).pathname.split("/").pop() || "";
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
  } catch {
    return "";
  }
}

export function baseNameOf(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    const dot = last.lastIndexOf(".");
    return dot > 0 ? last.slice(0, dot) : last;
  } catch {
    return "";
  }
}

const GENERIC_NAMES = new Set(["index", "playlist", "master", "manifest", "chunklist", "prog_index", "video", "stream", "media", "main", "mono"]);

/** Коротка назва для списку: для типових назв на кшталт index додаємо батьківську папку. */
export function labelOf(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
    const name = baseNameOf(url);
    if (GENERIC_NAMES.has(name.toLowerCase()) && parts.length > 1) return `${parts.at(-2)}/${name}`;
    return name || new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Визначає, чи є відповідь медіафайлом.
 * @returns {{kind: "hls" | "file", ext: string, mime: string} | null}
 */
export function classify(url, contentType = "") {
  if (!/^https?:/i.test(url)) return null;
  const mime = contentType.split(";")[0].trim().toLowerCase();
  const ext = extensionOf(url);

  if (HLS_MIME.has(mime) || ext === "m3u8") return { kind: "hls", ext: "m3u8", mime };
  if (SEGMENT_MIME.has(mime) || SEGMENT_EXT.has(ext)) return null;

  if (FILE_EXT.has(ext)) return { kind: "file", ext, mime };
  if (mime.startsWith("video/") || mime.startsWith("audio/")) {
    return { kind: "file", ext: MIME_EXT[mime] || mime.split("/")[1].replace(/^x-/, ""), mime };
  }
  return null;
}

/** Повний розмір файлу з Content-Range (для відповідей 206) або Content-Length. */
export function sizeFromHeaders(headers) {
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value;
  const range = get("content-range");
  const total = range && /\/(\d+)\s*$/.exec(range);
  if (total) return Number(total[1]);
  const length = get("content-length");
  return length && /^\d+$/.test(length) ? Number(length) : null;
}

export function hostMatches(url, domains) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith("." + d));
}

/** Робить рядок придатним для назви файлу в Windows, macOS і Linux. */
export function safeFileName(name, fallback = "video") {
  const cleaned = String(name || "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

export function joinPath(folder, fileName) {
  const dir = safeFileName(folder, "");
  return dir ? `${dir}/${fileName}` : fileName;
}

export function formatSize(bytes) {
  if (bytes == null) return "";
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString("uk-UA", { maximumFractionDigits: digits })} ${units[unit]}`;
}

// Офіційна транслітерація (постанова КМУ № 55 від 27.01.2010), спрощена:
// використовується лише як запасна назва файлу, коли система не приймає кирилицю.
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y",
  і: "i", ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s",
  т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu",
  я: "ia", ы: "y", э: "e", ё: "io", ъ: "", "'": "", "’": "", "ʼ": "",
};

export function asciiFileName(name) {
  const out = [...name].map((ch) => {
    const lower = ch.toLowerCase();
    if (!(lower in TRANSLIT)) return ch;
    const latin = TRANSLIT[lower];
    return ch !== lower && latin ? latin[0].toUpperCase() + latin.slice(1) : latin;
  }).join("");
  return out.replace(/[^\x20-\x7e]/g, "_");
}

/** chrome.downloads.download із запасною латинською назвою. */
export async function startDownload(options) {
  try {
    return await chrome.downloads.download(options);
  } catch (error) {
    if (!/filename/i.test(error?.message || "")) throw error;
    return chrome.downloads.download({ ...options, filename: asciiFileName(options.filename) });
  }
}
