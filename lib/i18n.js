export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

/** Підставляє тексти в елементи з атрибутами data-i18n / data-i18n-title / data-i18n-placeholder. */
export function localizePage(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
}
