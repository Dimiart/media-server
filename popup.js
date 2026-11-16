import { localizePage, t } from "./lib/i18n.js";
import { baseNameOf, formatSize, labelOf, joinPath, safeFileName, startDownload } from "./lib/media.js";
import { loadSettings } from "./lib/settings.js";

localizePage();

const $ = (id) => document.getElementById(id);
const list = $("list");
const template = $("item-template");
const selected = new Set();
let items = [];
let tab;

// ?tabId= використовується під час перевірки розширення в тестах.
async function resolveTab() {
  const forced = Number(new URLSearchParams(location.search).get("tabId"));
  if (forced) return chrome.tabs.get(forced);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active;
}

function displayName(item, settings) {
  const fromUrl = baseNameOf(item.url);
  const base = settings.useTitleAsName && tab?.title ? tab.title : fromUrl || tab?.title;
  return safeFileName(base, item.kind === "hls" ? "video" : "file");
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

async function downloadItem(item, settings, activate = true) {
  if (item.kind === "hls") {
    const id = crypto.randomUUID();
    await chrome.storage.session.set({
      [`job:${id}`]: {
        url: item.url,
        pageUrl: tab?.url || "",
        name: displayName(item, settings),
      },
    });
    await chrome.tabs.create({ url: `download.html?job=${id}`, active: activate });
    return;
  }
  const filename = joinPath(settings.folder, `${displayName(item, settings)}.${item.ext}`);
  await startDownload({ url: item.url, filename, conflictAction: "uniquify" });
  setStatus(t("popupStarted"));
}

function render(settings) {
  list.replaceChildren();
  $("empty").hidden = items.length > 0;
  $("toolbar").hidden = items.length === 0;
  for (const id of [...selected]) if (!items.some((i) => i.id === id)) selected.delete(id);

  for (const item of items) {
    const node = template.content.firstElementChild.cloneNode(true);
    localizePage(node);
    const name = labelOf(item.url);
    node.querySelector(".name").textContent = name;
    node.querySelector(".name").title = item.url;
    const kind = item.kind === "hls" ? t("kindHls") : item.ext.toUpperCase();
    // Для HLS відомий лише розмір списку відтворення, а не відео — не показуємо його.
    const size = item.kind === "hls" ? "" : formatSize(item.size);
    node.querySelector(".meta").textContent = [kind, size].filter(Boolean).join(" · ");

    const pick = node.querySelector(".pick");
    pick.checked = selected.has(item.id);
    pick.setAttribute("aria-label", name);
    pick.addEventListener("change", () => {
      if (pick.checked) selected.add(item.id);
      else selected.delete(item.id);
      syncSelection();
    });
    node.querySelector(".download").addEventListener("click", () =>
      downloadItem(item, settings).catch((e) => setStatus(t("errorGeneric", e.message), true)),
    );
    node.querySelector(".copy").addEventListener("click", async () => {
      await navigator.clipboard.writeText(item.url);
      setStatus(t("popupCopied"));
    });
    list.append(node);
  }
  syncSelection();
}

function syncSelection() {
  $("download-selected").disabled = selected.size === 0;
  $("select-all").checked = items.length > 0 && selected.size === items.length;
  $("select-all").indeterminate = selected.size > 0 && selected.size < items.length;
}

async function main() {
  tab = await resolveTab();
  let settings = await loadSettings();
  const key = `tab:${tab?.id}`;
  const load = async () => {
    const { [key]: state } = await chrome.storage.session.get(key);
    items = state?.items || [];
    render(settings);
  };

  $("select-all").addEventListener("change", (e) => {
    selected.clear();
    if (e.target.checked) items.forEach((i) => selected.add(i.id));
    render(settings);
  });
  $("download-selected").addEventListener("click", async () => {
    const chosen = items.filter((i) => selected.has(i.id));
    // Спочатку звичайні файли: перехід на вкладку HLS закриває це вікно.
    chosen.sort((a, b) => (a.kind === "hls") - (b.kind === "hls"));
    const last = chosen.at(-1);
    for (const item of chosen) {
      try {
        await downloadItem(item, settings, item === last);
      } catch (e) {
        setStatus(t("errorGeneric", e.message), true);
      }
    }
  });
  $("clear").addEventListener("click", () => chrome.runtime.sendMessage({ type: "clear-tab", tabId: tab.id }));
  $("open-options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "session" && changes[key]) load();
    if (area === "local" && changes.settings) {
      settings = await loadSettings();
      render(settings);
    }
  });
  await load();
}

main().catch((e) => setStatus(t("errorGeneric", e.message), true));
