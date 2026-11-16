import { localizePage, t } from "./lib/i18n.js";
import { DEFAULTS, loadSettings, saveSettings } from "./lib/settings.js";

localizePage();

const $ = (id) => document.getElementById(id);

function fill(s) {
  $("minSizeKb").value = s.minSizeKb;
  $("ignoredDomains").value = s.ignoredDomains.join("\n");
  $("folder").value = s.folder;
  $("concurrency").value = s.concurrency;
  $("useTitleAsName").checked = s.useTitleAsName;
  $("showBadge").checked = s.showBadge;
}

function read() {
  return {
    minSizeKb: $("minSizeKb").value,
    ignoredDomains: $("ignoredDomains").value.split(/[\s,]+/),
    folder: $("folder").value,
    concurrency: $("concurrency").value,
    useTitleAsName: $("useTitleAsName").checked,
    showBadge: $("showBadge").checked,
  };
}

function saved() {
  $("status").textContent = t("optSaved");
  setTimeout(() => ($("status").textContent = ""), 2000);
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  fill(await saveSettings(read()));
  saved();
});

$("reset").addEventListener("click", async () => {
  if (!confirm(t("optResetConfirm"))) return;
  fill(await saveSettings(DEFAULTS));
  saved();
});

loadSettings().then(fill);
