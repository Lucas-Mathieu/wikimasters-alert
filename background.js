"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  showNotification: true,
  playSound: true,
  bringToFront: false,
  thresholdSeconds: 30,
  disabledAuctionIds: [],
  auctionAlertsEnabledByDefault: true,
  auctionAlertOverrides: {},
  auctionThresholdOverrides: {}
});

const SITE_ORIGINS = new Set([
  "https://www.wiki-masters.com",
  "https://wiki-masters.com"
]);
const SITE_URL_PATTERNS = Array.from(SITE_ORIGINS, (origin) => `${origin}/*`);
const PRIMARY_SITE_ORIGIN = "https://www.wiki-masters.com";
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const ALERT_HISTORY_KEY = "alertedAuctionCycles";
const CUSTOM_ALERTS_KEY = "customAlertWindows";
const SCHEDULED_AUCTIONS_KEY = "scheduledAuctionAlerts";
const AUCTION_ALARM_PREFIX = "wikimasters-auction:";
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const processingCycles = new Set();
let creatingOffscreenDocument = null;
let cycleClaimQueue = Promise.resolve();
let customAlertMutationQueue = Promise.resolve();
let scheduledAuctionMutationQueue = Promise.resolve();

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

  if (message.type === "AUCTION_SNAPSHOT") {
    scheduleAuctionAlert(message.auction, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.error("WikiMasters Alert: programmation impossible", error);
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

  if (message.type === "GET_ALL_AUCTIONS") {
    collectOpenAuctions()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "OPEN_SETTINGS") {
    openAuctionSettings(sender.tab)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
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

chrome.alarms.onAlarm.addListener((alarm) => {
  handleAuctionAlarm(alarm).catch((error) => {
    console.error("WikiMasters Alert: alarme impossible", error);
  });
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
    auctionThresholdOverrides: stored.auctionThresholdOverrides && typeof stored.auctionThresholdOverrides === "object"
      ? stored.auctionThresholdOverrides
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
    return SITE_ORIGINS.has(new URL(tab?.url).origin);
  } catch {
    return false;
  }
}

async function queryWikiMastersTabs() {
  return chrome.tabs.query({ url: SITE_URL_PATTERNS });
}

async function collectOpenAuctions() {
  const tabs = (await queryWikiMastersTabs()).filter(isWikiMastersTab);
  const responses = await Promise.all(tabs.map(async (tab) => {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_MONITOR_STATUS" });
      return response?.ok ? { tab, response } : null;
    } catch {
      return null;
    }
  }));

  const auctionsById = new Map();
  let respondingTabs = 0;

  for (const entry of responses) {
    if (!entry) continue;
    respondingTabs += 1;

    for (const auction of entry.response.auctions || []) {
      const normalized = {
        id: String(auction.id || "").slice(0, 300),
        title: String(auction.title || "Enchère WikiMasters").trim().slice(0, 160),
        secondsRemaining: Math.max(0, Math.round(Number(auction.secondsRemaining) || 0)),
        tabId: entry.tab.id,
        windowId: entry.tab.windowId,
        pageUrl: entry.tab.url
      };
      if (!normalized.id || normalized.secondsRemaining <= 0) continue;

      const previous = auctionsById.get(normalized.id);
      if (!previous || normalized.secondsRemaining < previous.secondsRemaining) {
        auctionsById.set(normalized.id, normalized);
      }
    }
  }

  return {
    auctions: Array.from(auctionsById.values()).sort(
      (left, right) => left.secondsRemaining - right.secondsRemaining
    ),
    totalTabs: tabs.length,
    respondingTabs
  };
}

async function openAuctionSettings(tab) {
  if (chrome.action?.openPopup) {
    try {
      await chrome.action.openPopup(tab?.windowId ? { windowId: tab.windowId } : undefined);
      return { mode: "action-popup" };
    } catch {
      // Certaines versions refusent encore openPopup() depuis un content script.
    }
  }

  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?mode=window"),
    type: "popup",
    width: 390,
    height: 700,
    focused: true
  });
  return { mode: "window", windowId: created.id };
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

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function auctionAlarmName(auctionId) {
  return `${AUCTION_ALARM_PREFIX}${hashString(auctionId)}`;
}

async function scheduleAuctionAlert(rawAuction, sender) {
  const auction = validateAuctionPayload(rawAuction, sender);
  const settings = await getSettings();
  const alarmName = auctionAlarmName(auction.id);

  if (!settings.enabled || !isAuctionAlertEnabled(settings, auction.id)) {
    await removeScheduledAuction(alarmName);
    return { scheduled: false, reason: "disabled" };
  }

  const now = Date.now();
  const thresholdSeconds = auctionThresholdSeconds(settings, auction.id);
  const estimatedEndAt = now + auction.secondsRemaining * 1000;
  const scheduledFor = estimatedEndAt - thresholdSeconds * 1000;

  if (scheduledFor <= now + 250) {
    await removeScheduledAuction(alarmName);
    return handleAuctionAlert(auction, sender);
  }

  await mutateScheduledAuctions((scheduled) => {
    scheduled[alarmName] = {
      auction,
      tabId: sender.tab.id,
      windowId: sender.tab.windowId,
      pageUrl: sender.tab.url,
      estimatedEndAt,
      scheduledFor
    };
  });
  await chrome.alarms.create(alarmName, { when: scheduledFor });

  return { scheduled: true, scheduledFor };
}

async function handleAuctionAlarm(alarm) {
  if (!alarm?.name?.startsWith(AUCTION_ALARM_PREFIX)) return;

  const scheduled = await getScheduledAuctions();
  const entry = scheduled[alarm.name];
  if (!entry) return;

  const settings = await getSettings();
  if (!settings.enabled || !isAuctionAlertEnabled(settings, entry.auction.id)) {
    await removeScheduledAuction(alarm.name);
    return { accepted: false, reason: "disabled" };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(entry.tabId);
  } catch {
    await removeScheduledAuction(alarm.name);
    return { accepted: false, reason: "tab-closed" };
  }

  if (!isWikiMastersTab(tab) || tab.url !== entry.pageUrl) {
    await removeScheduledAuction(alarm.name);
    return { accepted: false, reason: "page-changed" };
  }

  const now = Date.now();
  const thresholdSeconds = auctionThresholdSeconds(settings, entry.auction.id);
  const desiredTime = entry.estimatedEndAt - thresholdSeconds * 1000;

  if (desiredTime > now + 250) {
    await mutateScheduledAuctions((items) => {
      if (items[alarm.name]) items[alarm.name].scheduledFor = desiredTime;
    });
    await chrome.alarms.create(alarm.name, { when: desiredTime });
    return { accepted: false, reason: "rescheduled" };
  }

  const secondsRemaining = Math.max(1, Math.floor((entry.estimatedEndAt - now) / 1000));
  const result = await handleAuctionAlert(
    { ...entry.auction, secondsRemaining },
    { tab }
  );
  await removeScheduledAuction(alarm.name);
  return result;
}

async function getScheduledAuctions() {
  const stored = await chrome.storage.session.get(SCHEDULED_AUCTIONS_KEY);
  return stored[SCHEDULED_AUCTIONS_KEY] || {};
}

function mutateScheduledAuctions(mutator) {
  const mutation = scheduledAuctionMutationQueue.then(async () => {
    const scheduled = await getScheduledAuctions();
    mutator(scheduled);
    await chrome.storage.session.set({ [SCHEDULED_AUCTIONS_KEY]: scheduled });
  });
  scheduledAuctionMutationQueue = mutation.catch(() => {});
  return mutation;
}

async function removeScheduledAuction(alarmName) {
  await chrome.alarms.clear(alarmName);
  await mutateScheduledAuctions((scheduled) => {
    delete scheduled[alarmName];
  });
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

  if (auction.secondsRemaining > auctionThresholdSeconds(settings, auction.id)) {
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

function auctionThresholdSeconds(settings, auctionId) {
  const override = Number.parseInt(settings.auctionThresholdOverrides?.[auctionId], 10);
  return Number.isFinite(override)
    ? Math.min(86400, Math.max(1, override))
    : settings.thresholdSeconds;
}

async function handleTestAlert() {
  const settings = await getSettings();
  const tab = await findWikiMastersTab();
  const auction = {
    id: "test",
    cycleId: `test:${Date.now()}`,
    title: "Alerte de test WikiMasters",
    secondsRemaining: settings.thresholdSeconds,
    pageUrl: tab?.url || PRIMARY_SITE_ORIGIN
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
    const claim = cycleClaimQueue.then(async () => {
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
    });
    cycleClaimQueue = claim.catch(() => {});
    return await claim;
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
  return mutateCustomAlerts((alerts) => {
    alerts[alertId] = alert;
  });
}

async function updateCustomAlert(alertId, updates) {
  return mutateCustomAlerts((alerts) => {
    if (alerts[alertId]) {
      alerts[alertId] = { ...alerts[alertId], ...updates };
    }
  });
}

async function removeCustomAlert(alertId) {
  return mutateCustomAlerts((alerts) => {
    delete alerts[alertId];
  });
}

async function removeCustomAlertByWindowId(windowId) {
  return mutateCustomAlerts((alerts) => {
    for (const [alertId, alert] of Object.entries(alerts)) {
      if (alert.alertWindowId === windowId) {
        delete alerts[alertId];
      }
    }
  });
}

function mutateCustomAlerts(mutator) {
  const mutation = customAlertMutationQueue.then(async () => {
    const alerts = await getCustomAlerts();
    mutator(alerts);
    await chrome.storage.session.set({ [CUSTOM_ALERTS_KEY]: alerts });
  });
  customAlertMutationQueue = mutation.catch(() => {});
  return mutation;
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
  const windowId = tab.windowId ?? knownWindowId;
  const browserWindow = await chrome.windows.get(windowId);

  if (browserWindow.state === "minimized") {
    await chrome.windows.update(windowId, { state: "normal" });
  }

  await chrome.tabs.update(tabId, { active: true });
  const focusedWindow = await chrome.windows.update(windowId, { focused: true });

  if (focusedWindow?.focused === false) {
    await chrome.windows.update(windowId, { drawAttention: true });
  }
}

async function findWikiMastersTab() {
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeWikiMastersTab = activeTabs.find(isWikiMastersTab);
  if (activeWikiMastersTab) {
    return activeWikiMastersTab;
  }

  const siteTabs = await queryWikiMastersTabs();
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
