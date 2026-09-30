(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showNotification: true,
    playSound: true,
    bringToFront: false,
    thresholdSeconds: 30
  });

  const SETTING_IDS = Object.keys(DEFAULT_SETTINGS);
  const controls = Object.fromEntries(
    SETTING_IDS.map((id) => [id, document.getElementById(id)])
  );
  const statusElement = document.getElementById("status");
  const monitorDetail = document.getElementById("monitorDetail");
  const testButton = document.getElementById("testAlert");

  function normalizeThreshold(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(86400, Math.max(1, parsed)) : 30;
  }

  function updateStatus(enabled, message = "") {
    statusElement.className = `status${enabled ? " status--active" : ""}`;
    statusElement.textContent = message || (enabled ? "Surveillance active" : "Désactivée");
  }

  function setMonitorDetail(message, isError = false) {
    monitorDetail.textContent = message;
    monitorDetail.className = `monitor-detail${isError ? " monitor-detail--error" : ""}`;
  }

  async function refreshMonitorStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://www.wiki-masters.com/")) {
      setMonitorDetail("Ouvrez un onglet WikiMasters pour voir les enchères détectées.");
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_MONITOR_STATUS" });
      if (!response?.ok) {
        throw new Error("Réponse de surveillance absente");
      }

      if (!response.scannedAt) {
        setMonitorDetail("Analyse de la page en cours…");
      } else if (response.auctions.length === 0) {
        setMonitorDetail("Aucune enchère active détectée sur cet onglet.", true);
      } else {
        const closest = response.auctions.reduce((best, auction) =>
          auction.secondsRemaining < best.secondsRemaining ? auction : best
        );
        setMonitorDetail(
          `${response.auctions.length} enchère${response.auctions.length > 1 ? "s" : ""} détectée${response.auctions.length > 1 ? "s" : ""} · ${closest.secondsRemaining} s restantes`
        );
      }
    } catch (error) {
      console.debug("État du content script indisponible", error);
      setMonitorDetail("Rechargez cet onglet WikiMasters après avoir actualisé l’extension.", true);
    }
  }

  async function loadSettings() {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);

    for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
      const control = controls[key];
      const value = stored[key] ?? defaultValue;

      if (control.type === "checkbox") {
        control.checked = Boolean(value);
      } else {
        control.value = normalizeThreshold(value);
      }
    }

    updateStatus(controls.enabled.checked);
    testButton.disabled = false;
    await refreshMonitorStatus();
  }

  async function saveControl(control) {
    const value = control.type === "checkbox"
      ? control.checked
      : normalizeThreshold(control.value);

    if (control.type === "number") {
      control.value = value;
    }

    await chrome.storage.local.set({ [control.id]: value });

    if (control.id === "enabled") {
      updateStatus(value);
    }

    await refreshMonitorStatus();
  }

  for (const control of Object.values(controls)) {
    control.addEventListener("change", async () => {
      try {
        await saveControl(control);
      } catch (error) {
        console.error("Impossible d’enregistrer le réglage", error);
        statusElement.className = "status status--error";
        statusElement.textContent = "Erreur d’enregistrement";
      }
    });
  }

  testButton.addEventListener("click", async () => {
    testButton.disabled = true;

    try {
      const response = await chrome.runtime.sendMessage({ type: "TEST_ALERT" });
      if (!response?.ok) {
        throw new Error(response?.error || "Le service d’alerte ne répond pas");
      }

      const notification = response.channels?.notification;
      if (notification?.requested && !notification.ok) {
        updateStatus(false, "Fenêtre d’alerte impossible");
        statusElement.className = "status status--error";
        setMonitorDetail(notification.error || "Chrome n’a pas créé la fenêtre d’alerte.", true);
      } else if (notification?.ok) {
        updateStatus(controls.enabled.checked, "Fenêtre d’alerte Chrome ouverte");
        setMonitorDetail("Cette alerte ne dépend pas des notifications Windows.");
      } else {
        updateStatus(controls.enabled.checked, "Test exécuté sans fenêtre d’alerte");
        setMonitorDetail("Activez « Afficher une alerte Chrome » pour tester ce canal.");
      }

      window.setTimeout(async () => {
        updateStatus(controls.enabled.checked);
        await refreshMonitorStatus();
      }, 3500);
    } catch (error) {
      console.error("Échec du test d’alerte", error);
      statusElement.className = "status status--error";
      statusElement.textContent = "Test indisponible";
    } finally {
      testButton.disabled = false;
    }
  });

  loadSettings().catch((error) => {
    console.error("Impossible de charger les réglages", error);
    statusElement.className = "status status--error";
    statusElement.textContent = "Réglages indisponibles";
  });

  window.setInterval(() => {
    refreshMonitorStatus().catch(() => {});
  }, 1500);
})();
