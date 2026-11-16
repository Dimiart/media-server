export const DEFAULTS = Object.freeze({
  minSizeKb: 100,
  ignoredDomains: [],
  useTitleAsName: true,
  folder: "",
  concurrency: 4,
  showBadge: true,
});

export function normalize(raw = {}) {
  const s = { ...DEFAULTS, ...raw };
  s.minSizeKb = Math.max(0, Math.min(1_000_000, Number(s.minSizeKb) || 0));
  s.concurrency = Math.max(1, Math.min(10, Math.round(Number(s.concurrency) || DEFAULTS.concurrency)));
  s.ignoredDomains = (Array.isArray(s.ignoredDomains) ? s.ignoredDomains : [])
    .map((d) => String(d).trim().toLowerCase().replace(/^\*?\./, "").replace(/^https?:\/\//, "").split("/")[0])
    .filter(Boolean);
  s.useTitleAsName = Boolean(s.useTitleAsName);
  s.showBadge = Boolean(s.showBadge);
  s.folder = String(s.folder || "").trim();
  return s;
}

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return normalize(settings);
}

export async function saveSettings(settings) {
  const value = normalize(settings);
  await chrome.storage.local.set({ settings: value });
  return value;
}
