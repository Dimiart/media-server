// Сторінка завантаження потокового відео (HLS).

import { DownloadError, downloadPlaylist, fetchBytes } from "./lib/downloader.js";
import { isMaster, isPlaylist, outputExtension, parseMaster, parseMedia } from "./lib/hls-playlist.js";
import { localizePage, t } from "./lib/i18n.js";
import { formatSize, joinPath, safeFileName, startDownload } from "./lib/media.js";
import { loadSettings } from "./lib/settings.js";

localizePage();

const $ = (id) => document.getElementById(id);
const canWriteToDisk = typeof window.showDirectoryPicker === "function";
let controller = null;
let master = null;
let settings;

function message(text, isError = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", isError);
}

function errorText(error) {
  if (error instanceof DownloadError) {
    if (error.code === "http") return t("errorHttp", error.detail.status);
    if (error.code === "decrypt") return t("errorDecrypt");
    if (error.code === "drm") return t("errorDrm");
    if (error.code === "empty") return t("errorEmpty");
    if (error.code === "not-playlist") return t("errorNotPlaylist");
    return t("errorNetwork");
  }
  return t("errorGeneric", error?.message || String(error));
}

async function fetchText(url, signal) {
  return new TextDecoder().decode(await fetchBytes(url, { signal }));
}

// Частина сайтів віддає відео лише з правильним Referer — підставляємо адресу сторінки
// для запитів цієї вкладки (і лише її).
async function setReferer(pageUrl) {
  if (!/^https?:/.test(pageUrl)) return;
  const current = await chrome.tabs.getCurrent();
  if (!current) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [current.id],
    addRules: [{
      id: current.id,
      priority: 1,
      condition: { tabIds: [current.id], resourceTypes: ["xmlhttprequest"] },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "referer", operation: "set", value: pageUrl }],
      },
    }],
  });
  addEventListener("pagehide", () => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [current.id] }));
}

function variantLabel(v) {
  const parts = [];
  if (v.height) parts.push(`${v.height}p`);
  if (v.bandwidth) parts.push(t("bitrate", (v.bandwidth / 1e6).toLocaleString("uk-UA", { maximumFractionDigits: 1 })));
  return parts.join(" · ") || t("dlVariantUnknown");
}

function fillAudio() {
  const variant = master?.variants[Number($("variant").value)];
  const tracks = master?.audio.filter((a) => variant?.audioGroup && a.groupId === variant.audioGroup) || [];
  $("audio-field").hidden = tracks.length === 0;
  $("audio").replaceChildren(
    ...tracks.map((a, i) => new Option(a.name || a.language || t("dlTrack", i + 1), a.url, false, a.isDefault)),
  );
}

async function loadMedia(url, signal) {
  const text = await fetchText(url, signal);
  if (!isPlaylist(text)) throw new DownloadError("not-playlist");
  const playlist = parseMedia(text, url);
  if (playlist.unsupported) throw new DownloadError("drm");
  if (!playlist.segments.length) throw new DownloadError("empty");
  return playlist;
}

function describe(playlist) {
  const minutes = Math.floor(playlist.duration / 60);
  const seconds = Math.round(playlist.duration % 60);
  const info = [t("dlInfo", playlist.segments.length, `${minutes}:${String(seconds).padStart(2, "0")}`)];
  if (!playlist.endList) info.push(t("dlLive"));
  return info.join(" ");
}

async function uniqueFile(dir, fileName) {
  const dot = fileName.lastIndexOf(".");
  const stem = fileName.slice(0, dot);
  const ext = fileName.slice(dot);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? fileName : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
    } catch {
      return dir.getFileHandle(candidate, { create: true });
    }
  }
  return dir.getFileHandle(`${stem} ${Date.now()}${ext}`, { create: true });
}

const MIME_BY_EXT = { ts: "video/mp2t", mp4: "video/mp4", m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg" };

async function saveViaDownloads(parts, fileName) {
  const type = MIME_BY_EXT[fileName.split(".").pop()] || "application/octet-stream";
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const id = await startDownload({
    url,
    filename: joinPath(settings.folder, fileName),
    conflictAction: "uniquify",
  });
  const done = (delta) => {
    if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
      URL.revokeObjectURL(url);
      chrome.downloads.onChanged.removeListener(done);
    }
  };
  chrome.downloads.onChanged.addListener(done);
}

async function downloadTrack({ playlist, fileName, label, dir, signal }) {
  $("phase").textContent = label;
  $("progress").value = 0;
  const started = performance.now();
  const onProgress = ({ done, total, bytes }) => {
    $("progress").value = done / total;
    const seconds = (performance.now() - started) / 1000;
    const speed = seconds > 0 ? formatSize(bytes / seconds) : "";
    $("progress-text").textContent = t("dlProgress", done, total, formatSize(bytes), speed);
  };

  if (dir) {
    const handle = await uniqueFile(dir, fileName);
    const writable = await handle.createWritable();
    try {
      await downloadPlaylist({ playlist, signal, concurrency: settings.concurrency, onProgress, write: (c) => writable.write(c) });
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      await dir.removeEntry(handle.name).catch(() => {});
      throw error;
    }
    return handle.name;
  }

  const parts = [];
  await downloadPlaylist({
    playlist,
    signal,
    concurrency: settings.concurrency,
    onProgress,
    write: async (c) => parts.push(new Blob([c])),
  });
  await saveViaDownloads(parts, fileName);
  return fileName;
}

async function start() {
  message("");
  const name = safeFileName($("name").value, "video");
  let dir = null;
  if (canWriteToDisk && $("to-disk").checked) {
    try {
      dir = await window.showDirectoryPicker({ id: "media-saver", mode: "readwrite", startIn: "downloads" });
    } catch {
      return; // Користувач закрив вікно вибору папки.
    }
  }

  controller = new AbortController();
  const { signal } = controller;
  $("choose").hidden = true;
  $("progress-box").hidden = false;
  $("saved").replaceChildren();

  try {
    const videoUrl = master ? master.variants[Number($("variant").value)].url : job.url;
    const audioUrl = master && !$("audio-field").hidden ? $("audio").value : null;
    $("phase").textContent = t("dlPreparing");
    const video = await loadMedia(videoUrl, signal);
    const audio = audioUrl ? await loadMedia(audioUrl, signal) : null;

    const tracks = [{ playlist: video, fileName: `${name}.${outputExtension(video)}`, label: t(audio ? "dlPhaseVideo" : "dlPhaseAll") }];
    if (audio) {
      tracks[0].fileName = `${name}.video.${outputExtension(video)}`;
      tracks.push({ playlist: audio, fileName: `${name}.audio.${outputExtension(audio, true)}`, label: t("dlPhaseAudio") });
    }

    for (const track of tracks) {
      const saved = await downloadTrack({ ...track, dir, signal });
      const li = document.createElement("li");
      li.textContent = saved;
      $("saved").append(li);
    }
    message(audio ? t("dlDoneSeparate") : t("dlDone"));
  } catch (error) {
    message(signal.aborted ? t("dlStopped") : errorText(error), !signal.aborted);
    $("choose").hidden = false;
  } finally {
    $("progress-box").hidden = true;
    controller = null;
  }
}

$("stop").addEventListener("click", () => controller?.abort(new Error("stopped")));
$("start").addEventListener("click", start);
$("variant").addEventListener("change", fillAudio);
addEventListener("beforeunload", (e) => {
  if (controller) e.preventDefault();
});

let job;
async function main() {
  settings = await loadSettings();
  const id = new URLSearchParams(location.search).get("job");
  const key = `job:${id}`;
  ({ [key]: job } = await chrome.storage.session.get(key));
  if (!job) {
    message(t("errorNoJob"), true);
    return;
  }
  $("source").textContent = job.url;
  $("name").value = job.name;
  $("disk-field").hidden = !canWriteToDisk;
  $("disk-hint").hidden = !canWriteToDisk;
  await setReferer(job.pageUrl);

  message(t("dlLoading"));
  const text = await fetchText(job.url);
  if (!isPlaylist(text)) throw new DownloadError("not-playlist");

  if (isMaster(text)) {
    master = parseMaster(text, job.url);
    if (!master.variants.length) throw new DownloadError("empty");
    $("variant").replaceChildren(...master.variants.map((v, i) => new Option(variantLabel(v), String(i))));
    fillAudio();
    $("info").textContent = "";
  } else {
    const playlist = parseMedia(text, job.url);
    if (playlist.unsupported) throw new DownloadError("drm");
    if (!playlist.segments.length) throw new DownloadError("empty");
    $("variant").closest(".field").hidden = true;
    $("info").textContent = describe(playlist);
  }
  message("");
  $("choose").hidden = false;
}

main().catch((error) => message(errorText(error), true));
