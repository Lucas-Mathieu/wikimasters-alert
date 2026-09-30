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
  const testButton = document.getElementById("testAlert");

  function normalizeThreshold(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(86400, Math.max(1, parsed)) : 30;
  }

  function updateStatus(enabled, message = "") {
    statusElement.className = `status${enabled ? " status--active" : ""}`;
    statusElement.textContent = message || (enabled ? "Surveillance active" : "Désactivée");
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

      updateStatus(controls.enabled.checked, "Alerte de test envoyée");
      window.setTimeout(() => updateStatus(controls.enabled.checked), 1800);
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
})();
