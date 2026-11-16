// Фоновий скрипт: стежить за мережевими відповідями вкладок і запам'ятовує медіафайли.

import { classify, hostMatches, sizeFromHeaders } from "./lib/media.js";
import { loadSettings } from "./lib/settings.js";

const MAX_ITEMS = 300;
const tabKey = (tabId) => `tab:${tabId}`;

let settingsPromise = loadSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    settingsPromise = loadSettings();
    settingsPromise.then(refreshAllBadges);
  }
});

// Записи для однієї вкладки виконуються по черзі, щоб не загубити події.
const queues = new Map();
function updateTab(tabId, mutate) {
  const run = (queues.get(tabId) || Promise.resolve()).then(async () => {
    const key = tabKey(tabId);
    const { [key]: stored } = await chrome.storage.session.get(key);
    const state = stored || { items: [] };
    if (mutate(state) === false) return;
    await chrome.storage.session.set({ [key]: state });
    await setBadge(tabId, state.items.length);
  });
  const safe = run.catch((error) => console.warn("media-saver: tab update failed", error));
  queues.set(tabId, safe);
  safe.then(() => {
    if (queues.get(tabId) === safe) queues.delete(tabId);
  });
  return safe;
}

async function setBadge(tabId, count) {
  const { showBadge } = await settingsPromise;
  const text = showBadge && count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

async function refreshAllBadges() {
  const all = await chrome.storage.session.get(null);
  for (const [key, state] of Object.entries(all)) {
    if (key.startsWith("tab:")) await setBadge(Number(key.slice(4)), state.items.length);
  }
}

chrome.action.setBadgeBackgroundColor({ color: "#2563eb" }).catch(() => {});

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    if (details.initiator?.startsWith("chrome-extension://")) return;
    const headers = details.responseHeaders || [];
    const contentType = headers.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    const media = classify(details.url, contentType);
    if (!media) return;
    const size = sizeFromHeaders(headers);
    handleMedia(details.tabId, details.url, media, size);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "object", "other"] },
  ["responseHeaders"],
);

async function handleMedia(tabId, url, media, size) {
  const settings = await settingsPromise;
  if (hostMatches(url, settings.ignoredDomains)) return;
  if (media.kind === "file" && size != null && size < settings.minSizeKb * 1024) return;

  await updateTab(tabId, (state) => {
    const existing = state.items.find((i) => i.url === url);
    if (existing) {
      if (size == null || size <= (existing.size || 0)) return false;
      existing.size = size;
      return true;
    }
    state.items.push({ id: crypto.randomUUID(), url, size, time: Date.now(), ...media });
    if (state.items.length > MAX_ITEMS) state.items.splice(0, state.items.length - MAX_ITEMS);
    return true;
  });
}

// Новий документ у вкладці — починаємо список заново.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  updateTab(tabId, (state) => {
    if (!state.items.length) return false;
    state.items = [];
    return true;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
});

// Кнопка «Очистити список» у вікні розширення.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "clear-tab" && Number.isInteger(message.tabId)) {
    updateTab(message.tabId, (state) => {
      state.items = [];
      return true;
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
