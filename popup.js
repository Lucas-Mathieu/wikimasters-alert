(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    showNotification: true,
    playSound: true,
    bringToFront: false,
    thresholdSeconds: 30,
    auctionAlertsEnabledByDefault: true
  });

  const SETTING_IDS = Object.keys(DEFAULT_SETTINGS);
  const controls = Object.fromEntries(
    SETTING_IDS.map((id) => [id, document.getElementById(id)])
  );
  const statusElement = document.getElementById("status");
  const monitorDetail = document.getElementById("monitorDetail");
  const testButton = document.getElementById("testAlert");
  const auctionControls = document.getElementById("auctionControls");
  const auctionList = document.getElementById("auctionList");

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

  function renderAuctionControls(auctions) {
    auctionList.replaceChildren();
    auctionControls.hidden = auctions.length === 0;

    for (const auction of auctions) {
      const row = document.createElement("label");
      row.className = "auction-item";

      const text = document.createElement("span");
      text.className = "auction-item__text";

      const title = document.createElement("span");
      title.className = "auction-item__title";
      title.textContent = auction.title || "Enchère WikiMasters";

      const meta = document.createElement("span");
      meta.className = "auction-item__meta";
      meta.textContent = `${auction.secondsRemaining} s restantes · ${auction.enabled ? "alerte active" : "alerte coupée"}`;

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.role = "switch";
      toggle.className = "auction-toggle";
      toggle.checked = auction.enabled !== false;
      toggle.dataset.auctionId = auction.id;
      toggle.setAttribute("aria-label", `Alerte pour ${title.textContent}`);

      text.append(title, meta);
      row.append(text, toggle);
      auctionList.append(row);
    }
  }

  async function setAuctionEnabled(auctionId, enabled) {
    const stored = await chrome.storage.local.get({ auctionAlertOverrides: {} });
    const overrides = stored.auctionAlertOverrides && typeof stored.auctionAlertOverrides === "object"
      ? { ...stored.auctionAlertOverrides }
      : {};
    overrides[auctionId] = Boolean(enabled);

    await chrome.storage.local.set({
      auctionAlertOverrides: Object.fromEntries(Object.entries(overrides).slice(-500))
    });
  }

  function effectiveAuctionState(auctionId, stored) {
    const overrides = stored.auctionAlertOverrides && typeof stored.auctionAlertOverrides === "object"
      ? stored.auctionAlertOverrides
      : {};
    if (Object.prototype.hasOwnProperty.call(overrides, auctionId)) {
      return overrides[auctionId] !== false;
    }

    if (Array.isArray(stored.disabledAuctionIds) && stored.disabledAuctionIds.includes(auctionId)) {
      return false;
    }

    return stored.auctionAlertsEnabledByDefault !== false;
  }

  async function refreshMonitorStatus() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.startsWith("https://www.wiki-masters.com/")) {
      renderAuctionControls([]);
      setMonitorDetail("Ouvrez un onglet WikiMasters pour voir les enchères détectées.");
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_MONITOR_STATUS" });
      if (!response?.ok) {
        throw new Error("Réponse de surveillance absente");
      }

      const stored = await chrome.storage.local.get({
        disabledAuctionIds: [],
        auctionAlertsEnabledByDefault: true,
        auctionAlertOverrides: {}
      });
      const auctions = response.auctions.map((auction) => ({
        ...auction,
        enabled: effectiveAuctionState(auction.id, stored)
      }));

      if (!response.scannedAt) {
        renderAuctionControls([]);
        setMonitorDetail("Analyse de la page en cours…");
      } else if (auctions.length === 0) {
        renderAuctionControls([]);
        setMonitorDetail("Aucune enchère active détectée sur cet onglet.", true);
      } else {
        renderAuctionControls(auctions);
        const closest = auctions.reduce((best, auction) =>
          auction.secondsRemaining < best.secondsRemaining ? auction : best
        );
        setMonitorDetail(
          `${auctions.length} enchère${auctions.length > 1 ? "s" : ""} détectée${auctions.length > 1 ? "s" : ""} · ${closest.secondsRemaining} s restantes`
        );
      }
    } catch (error) {
      console.debug("État du content script indisponible", error);
      renderAuctionControls([]);
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

  auctionList.addEventListener("change", async (event) => {
    const toggle = event.target.closest(".auction-toggle");
    if (!toggle) return;

    toggle.disabled = true;
    try {
      await setAuctionEnabled(toggle.dataset.auctionId, toggle.checked);
      await refreshMonitorStatus();
    } catch (error) {
      console.error("Impossible de modifier l’alerte de cette enchère", error);
      toggle.checked = !toggle.checked;
      setMonitorDetail("Le réglage de cette enchère n’a pas pu être enregistré.", true);
    } finally {
      toggle.disabled = false;
    }
  });

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
