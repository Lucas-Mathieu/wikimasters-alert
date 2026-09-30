"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  showNotification: true,
  playSound: true,
  bringToFront: false,
  thresholdSeconds: 30,
  disabledAuctionIds: [],
  auctionAlertsEnabledByDefault: true,
  auctionAlertOverrides: {}
});

const SITE_ORIGIN = "https://www.wiki-masters.com";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ALERT_HISTORY_KEY = "alertedAuctionCycles";
const CUSTOM_ALERTS_KEY = "customAlertWindows";
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const processingCycles = new Set();
let creatingOffscreenDocument = null;

chrome.runtime.onInstalled.addListener(() => {
  initializeDefaultSettings().catch((error) => {
    console.error("WikiMasters Alert: réglages initiaux indisponibles", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target === "offscreen") {
    return false;
  }

  if (message.type === "AUCTION_THRESHOLD_REACHED") {
    handleAuctionAlert(message.auction, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("WikiMasters Alert: alerte impossible", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "TEST_ALERT") {
    handleTestAlert()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("WikiMasters Alert: test impossible", error);
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message.type === "OPEN_CUSTOM_ALERT") {
    openCustomAlertTarget(message.alertId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "DISMISS_CUSTOM_ALERT") {
    removeCustomAlert(message.alertId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
  removeCustomAlertByWindowId(windowId).catch(() => {});
});

async function initializeDefaultSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) {
      missing[key] = value;
    }
  }

  const overrides = stored.auctionAlertOverrides && typeof stored.auctionAlertOverrides === "object"
    ? { ...stored.auctionAlertOverrides }
    : {};
  let migrated = false;
  if (Array.isArray(stored.disabledAuctionIds)) {
    for (const id of stored.disabledAuctionIds) {
      if (typeof id === "string" && !Object.prototype.hasOwnProperty.call(overrides, id)) {
        overrides[id] = false;
        migrated = true;
      }
    }
  }
  if (migrated) {
    missing.auctionAlertOverrides = Object.fromEntries(Object.entries(overrides).slice(-500));
  }

  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
}

function normalizeSettings(stored) {
  const parsedThreshold = Number.parseInt(stored.thresholdSeconds, 10);
  return {
    enabled: stored.enabled !== false,
    showNotification: stored.showNotification !== false,
    playSound: stored.playSound !== false,
    bringToFront: stored.bringToFront === true,
    disabledAuctionIds: Array.isArray(stored.disabledAuctionIds)
      ? stored.disabledAuctionIds.filter((id) => typeof id === "string").slice(0, 500)
      : [],
    auctionAlertsEnabledByDefault: stored.auctionAlertsEnabledByDefault !== false,
    auctionAlertOverrides: stored.auctionAlertOverrides && typeof stored.auctionAlertOverrides === "object"
      ? stored.auctionAlertOverrides
      : {},
    thresholdSeconds: Number.isFinite(parsedThreshold)
      ? Math.min(86400, Math.max(1, parsedThreshold))
      : DEFAULT_SETTINGS.thresholdSeconds
  };
}

async function getSettings() {
  return normalizeSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
}

function isWikiMastersTab(tab) {
  try {
    return new URL(tab?.url).origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

function validateAuctionPayload(auction, sender) {
  if (!auction || !sender.tab || !isWikiMastersTab(sender.tab)) {
    throw new Error("Source d’alerte non autorisée");
  }

  const secondsRemaining = Number(auction.secondsRemaining);
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) {
    throw new Error("Temps restant invalide");
  }

  const cycleId = String(auction.cycleId || "").slice(0, 500);
  if (!cycleId) {
    throw new Error("Cycle d’enchère manquant");
  }

  return {
    id: String(auction.id || "enchere").slice(0, 300),
    cycleId,
    title: String(auction.title || "Enchère WikiMasters").trim().slice(0, 160),
    secondsRemaining: Math.round(secondsRemaining),
    pageUrl: String(auction.pageUrl || sender.tab.url).slice(0, 2000)
  };
}

async function handleAuctionAlert(rawAuction, sender) {
  const auction = validateAuctionPayload(rawAuction, sender);
  const settings = await getSettings();

  if (!settings.enabled) {
    return { accepted: false, reason: "disabled" };
  }

  if (!isAuctionAlertEnabled(settings, auction.id)) {
    return { accepted: false, reason: "auction-disabled" };
  }

  if (auction.secondsRemaining > settings.thresholdSeconds) {
    return { accepted: false, reason: "above-threshold" };
  }

  if (!(await claimAuctionCycle(auction.cycleId))) {
    return { accepted: false, reason: "duplicate" };
  }

  const channels = await dispatchAlert({
    auction,
    settings,
    tab: sender.tab,
    isTest: false
  });

  return { accepted: true, channels };
}

function isAuctionAlertEnabled(settings, auctionId) {
  if (Object.prototype.hasOwnProperty.call(settings.auctionAlertOverrides, auctionId)) {
    return settings.auctionAlertOverrides[auctionId] !== false;
  }

  if (settings.disabledAuctionIds.includes(auctionId)) {
    return false;
  }

  return settings.auctionAlertsEnabledByDefault;
}

async function handleTestAlert() {
  const settings = await getSettings();
  const tab = await findWikiMastersTab();
  const auction = {
    id: "test",
    cycleId: `test:${Date.now()}`,
    title: "Alerte de test WikiMasters",
    secondsRemaining: settings.thresholdSeconds,
    pageUrl: tab?.url || SITE_ORIGIN
  };

  const channels = await dispatchAlert({ auction, settings, tab, isTest: true });
  return { accepted: true, channels };
}

async function dispatchAlert({ auction, settings, tab, isTest }) {
  const operations = [];

  const channels = {
    notification: { requested: settings.showNotification, ok: null },
    sound: { requested: settings.playSound, ok: null },
    focus: { requested: settings.bringToFront, ok: null }
  };

  if (settings.bringToFront && tab) {
    channels.focus = await runAlertOperation(() => focusTab(tab.id, tab.windowId));
  }

  if (settings.showNotification) {
    operations.push(["notification", () => showCustomAlertWindow(auction, tab, isTest)]);
  }

  if (settings.playSound) {
    operations.push(["sound", () => playAlertSound()]);
  }

  const entries = await Promise.all(operations.map(async ([name, operation]) => {
    return [name, await runAlertOperation(operation, name)];
  }));

  Object.assign(channels, Object.fromEntries(entries));
  return channels;
}

async function runAlertOperation(operation, name = "focus") {
  try {
    const details = await operation();
    return { requested: true, ok: true, details: details || null };
  } catch (error) {
    console.error(`WikiMasters Alert: canal ${name} en échec`, error);
    return {
      requested: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function claimAuctionCycle(cycleId) {
  if (processingCycles.has(cycleId)) {
    return false;
  }

  processingCycles.add(cycleId);
  try {
    const now = Date.now();
    const stored = await chrome.storage.session.get(ALERT_HISTORY_KEY);
    const history = stored[ALERT_HISTORY_KEY] || {};

    for (const [key, timestamp] of Object.entries(history)) {
      if (!Number.isFinite(timestamp) || now - timestamp > HISTORY_TTL_MS) {
        delete history[key];
      }
    }

    if (history[cycleId]) {
      return false;
    }

    history[cycleId] = now;
    await chrome.storage.session.set({ [ALERT_HISTORY_KEY]: history });
    return true;
  } finally {
    processingCycles.delete(cycleId);
  }
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) {
    return `${seconds} seconde${seconds > 1 ? "s" : ""}`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours} h ${String(minutes).padStart(2, "0")} min`;
  }

  return `${minutes} min ${String(remainingSeconds).padStart(2, "0")} s`;
}

async function showCustomAlertWindow(auction, tab, isTest) {
  const alertId = `alert-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  await saveCustomAlert(alertId, {
    alertId,
    isTest,
    title: auction.title,
    duration: formatDuration(auction.secondsRemaining),
    secondsRemaining: auction.secondsRemaining,
    tabId: tab?.id ?? null,
    sourceWindowId: tab?.windowId ?? null,
    createdAt: Date.now(),
    alertWindowId: null
  });

  try {
    const alertWindow = await chrome.windows.create({
      url: chrome.runtime.getURL(`alert.html?alert=${encodeURIComponent(alertId)}`),
      type: "popup",
      width: 390,
      height: 270,
      focused: true
    });

    if (!Number.isInteger(alertWindow?.id)) {
      throw new Error("Chrome n’a pas créé la fenêtre d’alerte");
    }

    await updateCustomAlert(alertId, { alertWindowId: alertWindow.id });
    return { alertId, mode: "custom-window", windowId: alertWindow.id };
  } catch (error) {
    await removeCustomAlert(alertId);
    throw error;
  }
}

async function getCustomAlerts() {
  const stored = await chrome.storage.session.get(CUSTOM_ALERTS_KEY);
  const alerts = stored[CUSTOM_ALERTS_KEY] || {};
  const now = Date.now();

  for (const [id, alert] of Object.entries(alerts)) {
    if (!alert?.createdAt || now - alert.createdAt > HISTORY_TTL_MS) {
      delete alerts[id];
    }
  }

  return alerts;
}

async function saveCustomAlert(alertId, alert) {
  const alerts = await getCustomAlerts();
  alerts[alertId] = alert;
  await chrome.storage.session.set({ [CUSTOM_ALERTS_KEY]: alerts });
}

async function updateCustomAlert(alertId, updates) {
  const alerts = await getCustomAlerts();
  if (!alerts[alertId]) return;

  alerts[alertId] = { ...alerts[alertId], ...updates };
  await chrome.storage.session.set({ [CUSTOM_ALERTS_KEY]: alerts });
}

async function removeCustomAlert(alertId) {
  const alerts = await getCustomAlerts();

  if (alerts[alertId]) {
    delete alerts[alertId];
    await chrome.storage.session.set({ [CUSTOM_ALERTS_KEY]: alerts });
  }
}

async function removeCustomAlertByWindowId(windowId) {
  const alerts = await getCustomAlerts();
  let changed = false;

  for (const [alertId, alert] of Object.entries(alerts)) {
    if (alert.alertWindowId === windowId) {
      delete alerts[alertId];
      changed = true;
    }
  }

  if (changed) {
    await chrome.storage.session.set({ [CUSTOM_ALERTS_KEY]: alerts });
  }
}

async function openCustomAlertTarget(rawAlertId) {
  const alertId = String(rawAlertId || "").slice(0, 100);
  const alerts = await getCustomAlerts();
  const alert = alerts[alertId];

  if (!alert) {
    throw new Error("Cette alerte a expiré");
  }

  if (Number.isInteger(alert.tabId)) {
    await focusTab(alert.tabId, alert.sourceWindowId);
  }

  await removeCustomAlert(alertId);
}

async function focusTab(tabId, knownWindowId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId ?? knownWindowId, { focused: true });
}

async function findWikiMastersTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeWikiMastersTab = activeTabs.find(isWikiMastersTab);
  if (activeWikiMastersTab) {
    return activeWikiMastersTab;
  }

  const siteTabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` });
  return siteTabs.find((tab) => tab.active) || siteTabs[0] || null;
}

async function hasOffscreenDocument() {
  const documentUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [documentUrl]
    });
    return contexts.length > 0;
  }

  const clients = await self.clients.matchAll();
  return clients.some((client) => client.url === documentUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Jouer le son local d’alerte demandé par l’utilisateur"
    }).finally(() => {
      creatingOffscreenDocument = null;
    });
  }

  await creatingOffscreenDocument;
}

async function playAlertSound() {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "PLAY_ALERT_SOUND",
    target: "offscreen"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Lecture audio impossible");
  }
}
