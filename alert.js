(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const alertId = params.get("alert") || "";
  const titleElement = document.getElementById("auctionTitle");
  const durationElement = document.getElementById("duration");
  const eyebrowElement = document.getElementById("eyebrow");
  const errorElement = document.getElementById("error");
  const openButton = document.getElementById("openAuction");
  const dismissButton = document.getElementById("dismiss");

  async function getAlert() {
    const stored = await chrome.storage.session.get("customAlertWindows");
    return stored.customAlertWindows?.[alertId] || null;
  }

  async function initialize() {
    const alert = await getAlert();
    if (!alert) {
      titleElement.textContent = "Alerte expirée";
      durationElement.textContent = "—";
      openButton.hidden = true;
      return;
    }

    titleElement.textContent = alert.title || "Enchère WikiMasters";
    durationElement.textContent = alert.duration || `${alert.secondsRemaining} secondes`;
    eyebrowElement.textContent = alert.isTest
      ? "Test de l’alerte Chrome"
      : "Enchère bientôt terminée";
    openButton.hidden = !Number.isInteger(alert.tabId);
  }

  openButton.addEventListener("click", async () => {
    openButton.disabled = true;
    const response = await chrome.runtime.sendMessage({
      type: "OPEN_CUSTOM_ALERT",
      alertId
    });

    if (response?.ok) {
      window.close();
    } else {
      errorElement.textContent = response?.error || "L’onglet de l’enchère est introuvable.";
      openButton.disabled = false;
    }
  });

  dismissButton.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "DISMISS_CUSTOM_ALERT", alertId });
    window.close();
  });

  initialize().catch((error) => {
    console.error("WikiMasters Alert: fenêtre d’alerte indisponible", error);
    errorElement.textContent = "Impossible de charger les détails de l’alerte.";
    openButton.hidden = true;
  });
})();
