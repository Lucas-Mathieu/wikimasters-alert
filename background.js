"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  showNotification: true,
  playSound: true,
  bringToFront: false,
  thresholdSeconds: 30
});

const SITE_ORIGIN = "https://www.wiki-masters.com";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ALERT_HISTORY_KEY = "alertedAuctionCycles";
const NOTIFICATION_TARGETS_KEY = "notificationTargets";
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

  return false;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  focusNotificationTarget(notificationId)
    .catch((error) => {
      console.error("WikiMasters Alert: onglet de la notification introuvable", error);
    })
    .finally(() => chrome.notifications.clear(notificationId));
});

chrome.notifications.onClosed.addListener((notificationId) => {
  removeNotificationTarget(notificationId).catch(() => {});
});

async function initializeDefaultSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (stored[key] === undefined) {
      missing[key] = value;
    }
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

  if (auction.secondsRemaining > settings.thresholdSeconds) {
    return { accepted: false, reason: "above-threshold" };
  }

  if (!(await claimAuctionCycle(auction.cycleId))) {
    return { accepted: false, reason: "duplicate" };
  }

  await dispatchAlert({
    auction,
    settings,
    tab: sender.tab,
    isTest: false
  });

  return { accepted: true };
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

  await dispatchAlert({ auction, settings, tab, isTest: true });
  return { accepted: true };
}

async function dispatchAlert({ auction, settings, tab, isTest }) {
  const operations = [];

  if (settings.showNotification) {
    operations.push(showNotification(auction, tab, isTest));
  }

  if (settings.playSound) {
    operations.push(playAlertSound());
  }

  if (settings.bringToFront && tab) {
    operations.push(focusTab(tab.id, tab.windowId));
  }

  const results = await Promise.allSettled(operations);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("WikiMasters Alert: canal d’alerte en échec", result.reason);
    }
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

async function showNotification(auction, tab, isTest) {
  const notificationId = `wikimasters-${isTest ? "test" : "auction"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = isTest ? "Test de l’alerte WikiMasters" : "Une enchère se termine bientôt";
  const message = `${formatDuration(auction.secondsRemaining)} restante${auction.secondsRemaining > 1 ? "s" : ""}`;

  if (tab) {
    await saveNotificationTarget(notificationId, tab);
  }

  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      contextMessage: auction.title,
      priority: 2
    });
  } catch (error) {
    await removeNotificationTarget(notificationId);
    throw error;
  }
}

async function saveNotificationTarget(notificationId, tab) {
  const stored = await chrome.storage.session.get(NOTIFICATION_TARGETS_KEY);
  const targets = stored[NOTIFICATION_TARGETS_KEY] || {};
  targets[notificationId] = {
    tabId: tab.id,
    windowId: tab.windowId,
    savedAt: Date.now()
  };

  for (const [id, target] of Object.entries(targets)) {
    if (!target?.savedAt || Date.now() - target.savedAt > HISTORY_TTL_MS) {
      delete targets[id];
    }
  }

  await chrome.storage.session.set({ [NOTIFICATION_TARGETS_KEY]: targets });
}

async function removeNotificationTarget(notificationId) {
  const stored = await chrome.storage.session.get(NOTIFICATION_TARGETS_KEY);
  const targets = stored[NOTIFICATION_TARGETS_KEY] || {};

  if (targets[notificationId]) {
    delete targets[notificationId];
    await chrome.storage.session.set({ [NOTIFICATION_TARGETS_KEY]: targets });
  }
}

async function focusNotificationTarget(notificationId) {
  const stored = await chrome.storage.session.get(NOTIFICATION_TARGETS_KEY);
  const target = stored[NOTIFICATION_TARGETS_KEY]?.[notificationId];

  if (target) {
    await focusTab(target.tabId, target.windowId);
    await removeNotificationTarget(notificationId);
  }
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
