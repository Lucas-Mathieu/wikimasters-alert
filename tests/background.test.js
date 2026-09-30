"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let customWindowError = null;
let createdWindow = null;
let createdWindows = [];
let popupOpenedForWindow = null;
let queryTabs = null;
let tabResponses = new Map();
let browserWindowState = "normal";
let windowUpdates = [];
let focusRequestAccepted = true;
let createdAlarms = [];
let clearedAlarms = [];
let tabUpdateFailuresRemaining = 0;
let tabUpdateAttempts = 0;
let sessionStore = {};
let localSettings = {
  enabled: true,
  showNotification: true,
  playSound: false,
  bringToFront: false,
  thresholdSeconds: 40,
  disabledAuctionIds: [],
  auctionAlertsEnabledByDefault: true,
  auctionAlertOverrides: {},
  auctionThresholdOverrides: {}
};

const listeners = {
  installed: null,
  message: null,
  windowRemoved: null,
  alarm: null
};

const wikiTab = {
  id: 42,
  windowId: 7,
  active: true,
  url: "https://www.wiki-masters.com/auctions"
};

const chrome = {
  runtime: {
    getURL: (file) => `chrome-extension://test/${file}`,
    onInstalled: { addListener: (listener) => { listeners.installed = listener; } },
    onMessage: { addListener: (listener) => { listeners.message = listener; } },
    sendMessage: async () => ({ ok: true })
  },
  storage: {
    local: {
      get: async () => ({ ...localSettings }),
      set: async () => {}
    },
    session: {
      get: async (key) => ({ [key]: sessionStore[key] }),
      set: async (values) => { sessionStore = { ...sessionStore, ...values }; }
    }
  },
  tabs: {
    query: async () => queryTabs || [wikiTab],
    sendMessage: async (tabId) => {
      if (!tabResponses.has(tabId)) throw new Error("content script absent");
      return tabResponses.get(tabId);
    },
    get: async () => wikiTab,
    update: async () => {
      tabUpdateAttempts += 1;
      if (tabUpdateFailuresRemaining > 0) {
        tabUpdateFailuresRemaining -= 1;
        throw new Error("Tabs cannot be edited right now (user may be dragging a tab).");
      }
      return wikiTab;
    }
  },
  action: {
    openPopup: async ({ windowId } = {}) => { popupOpenedForWindow = windowId ?? null; }
  },
  alarms: {
    create: async (name, options) => { createdAlarms.push({ name, options }); },
    clear: async (name) => { clearedAlarms.push(name); return true; },
    onAlarm: { addListener: (listener) => { listeners.alarm = listener; } }
  },
  windows: {
    create: async (options) => {
      if (customWindowError) throw customWindowError;
      createdWindow = { id: 81, options };
      createdWindows.push(createdWindow);
      return { id: 81 };
    },
    get: async (windowId) => ({ id: windowId, state: browserWindowState, focused: false }),
    update: async (windowId, options) => {
      windowUpdates.push({ windowId, options });
      if (options.state) browserWindowState = options.state;
      return {
        id: windowId,
        state: browserWindowState,
        focused: options.focused === true && focusRequestAccepted
      };
    },
    onRemoved: { addListener: (listener) => { listeners.windowRemoved = listener; } }
  },
  offscreen: {
    createDocument: async () => {}
  }
};

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const testConsole = { ...console, error: () => {}, warn: () => {} };
const context = vm.createContext({
  chrome,
  console: testConsole,
  setTimeout,
  URL,
  self: { clients: { matchAll: async () => [] } }
});
vm.runInContext(source, context, { filename: "background.js" });

(async () => {
  const success = await vm.runInContext("handleTestAlert()", context);
  assert.equal(success.channels.notification.ok, true);
  assert.equal(success.channels.notification.details.mode, "custom-window");
  assert.equal(createdWindow.options.type, "popup");
  assert.match(createdWindow.options.url, /alert\.html\?alert=/);
  assert.equal(createdWindow.options.focused, true);

  customWindowError = new Error("window creation failed");
  const failed = await vm.runInContext("handleTestAlert()", context);
  assert.equal(failed.channels.notification.ok, false);
  assert.match(failed.channels.notification.error, /window creation failed/);

  assert.ok(listeners.message, "Le service worker doit écouter les messages");
  assert.ok(listeners.windowRemoved, "La fermeture de la fenêtre doit être gérée");
  assert.ok(listeners.alarm, "Les alarmes différées doivent être écoutées");

  localSettings.disabledAuctionIds = ["auction-42"];
  const disabled = await vm.runInContext(
    `handleAuctionAlert({
      id: "auction-42",
      cycleId: "auction-42:1",
      title: "Carte test",
      secondsRemaining: 20
    }, { tab: ${JSON.stringify(wikiTab)} })`,
    context
  );
  assert.equal(disabled.accepted, false);
  assert.equal(disabled.reason, "auction-disabled");

  assert.equal(vm.runInContext(`isAuctionAlertEnabled({
    disabledAuctionIds: [],
    auctionAlertsEnabledByDefault: false,
    auctionAlertOverrides: {}
  }, "auction-new")`, context), false);
  assert.equal(vm.runInContext(`isAuctionAlertEnabled({
    disabledAuctionIds: [],
    auctionAlertsEnabledByDefault: false,
    auctionAlertOverrides: { "auction-new": true }
  }, "auction-new")`, context), true);
  assert.equal(vm.runInContext(`auctionThresholdSeconds({
    thresholdSeconds: 40,
    auctionThresholdOverrides: { "auction-new": 12 }
  }, "auction-new")`, context), 12);
  assert.equal(vm.runInContext(`auctionThresholdSeconds({
    thresholdSeconds: 40,
    auctionThresholdOverrides: {}
  }, "auction-new")`, context), 40);

  const manyTabs = Array.from({ length: 15 }, (_, index) => ({
    id: 100 + index,
    windowId: index < 8 ? 10 : 11,
    url: `https://wiki-masters.com/marketplace/auction-${index + 1}`
  }));
  queryTabs = manyTabs;
  tabResponses = new Map(manyTabs.map((tab, index) => [tab.id, {
    ok: true,
    scannedAt: Date.now(),
    auctions: [{
      id: `page:/marketplace/auction-${index + 1}`,
      title: `Enchère ${index + 1}`,
      secondsRemaining: 900 - index * 10
    }]
  }]));

  const allAuctions = await vm.runInContext("collectOpenAuctions()", context);
  assert.equal(allAuctions.totalTabs, 15);
  assert.equal(allAuctions.respondingTabs, 15);
  assert.equal(allAuctions.auctions.length, 15);
  assert.equal(allAuctions.auctions[0].title, "Enchère 15");
  assert.equal(allAuctions.auctions[14].title, "Enchère 1");

  tabResponses.delete(manyTabs[4].id);
  const withOneSleepingTab = await vm.runInContext("collectOpenAuctions()", context);
  assert.equal(withOneSleepingTab.totalTabs, 15);
  assert.equal(withOneSleepingTab.respondingTabs, 14);
  assert.equal(withOneSleepingTab.auctions.length, 14);

  const settingsWindow = await vm.runInContext(
    `openAuctionSettings(${JSON.stringify(wikiTab)})`,
    context
  );
  assert.equal(settingsWindow.mode, "action-popup");
  assert.equal(popupOpenedForWindow, wikiTab.windowId);

  browserWindowState = "minimized";
  windowUpdates = [];
  await vm.runInContext(`focusTab(${wikiTab.id}, ${wikiTab.windowId})`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(windowUpdates)), [
    { windowId: wikiTab.windowId, options: { state: "normal" } },
    { windowId: wikiTab.windowId, options: { focused: true } }
  ]);

  focusRequestAccepted = false;
  windowUpdates = [];
  await vm.runInContext(`focusTab(${wikiTab.id}, ${wikiTab.windowId})`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(windowUpdates)), [
    { windowId: wikiTab.windowId, options: { focused: true } },
    { windowId: wikiTab.windowId, options: { drawAttention: true } }
  ]);
  focusRequestAccepted = true;

  tabUpdateFailuresRemaining = 2;
  tabUpdateAttempts = 0;
  await vm.runInContext(`focusTab(${wikiTab.id}, ${wikiTab.windowId})`, context);
  assert.equal(tabUpdateAttempts, 3);

  customWindowError = null;
  createdAlarms = [];
  clearedAlarms = [];
  const scheduledAlert = await vm.runInContext(
    `scheduleAuctionAlert({
      id: "scheduled-auction",
      cycleId: "scheduled-auction:1",
      title: "Enchère programmée",
      secondsRemaining: 120
    }, { tab: ${JSON.stringify(wikiTab)} })`,
    context
  );
  assert.equal(scheduledAlert.scheduled, true);
  assert.equal(createdAlarms.length, 1);
  assert.ok(createdAlarms[0].options.when > Date.now() + 70000);

  const scheduledAlarmName = createdAlarms[0].name;
  sessionStore.scheduledAuctionAlerts[scheduledAlarmName].estimatedEndAt = Date.now() + 10000;
  const alarmResult = await vm.runInContext(
    `handleAuctionAlarm({ name: ${JSON.stringify(scheduledAlarmName)} })`,
    context
  );
  assert.equal(alarmResult.accepted, true);
  assert.ok(clearedAlarms.includes(scheduledAlarmName));
  assert.equal(sessionStore.scheduledAuctionAlerts[scheduledAlarmName], undefined);

  createdAlarms = [];
  const scheduledAcrossTabs = await Promise.all(manyTabs.map((tab, index) => vm.runInContext(
    `scheduleAuctionAlert({
      id: "scheduled-${index + 1}",
      cycleId: "scheduled-${index + 1}:1",
      title: "Programmée ${index + 1}",
      secondsRemaining: ${120 + index}
    }, { tab: ${JSON.stringify(tab)} })`,
    context
  )));
  assert.equal(scheduledAcrossTabs.filter((result) => result.scheduled).length, 15);
  assert.equal(createdAlarms.length, 15);
  assert.equal(Object.keys(sessionStore.scheduledAuctionAlerts || {}).length, 15);

  createdWindows = [];
  localSettings.disabledAuctionIds = [];
  const simultaneousAlerts = await Promise.all(manyTabs.map((tab, index) => vm.runInContext(
    `handleAuctionAlert({
      id: "page:/marketplace/auction-${index + 1}",
      cycleId: "auction-${index + 1}:simultaneous",
      title: "Enchère ${index + 1}",
      secondsRemaining: 10
    }, { tab: ${JSON.stringify(tab)} })`,
    context
  )));
  assert.equal(simultaneousAlerts.filter((result) => result.accepted).length, 15);
  assert.equal(createdWindows.length, 15);
  assert.equal(
    Object.keys(sessionStore.alertedAuctionCycles || {}).filter((id) => id.endsWith(":simultaneous")).length,
    15
  );
  assert.equal(
    Object.values(sessionStore.customAlertWindows || {}).filter((alert) => /^Enchère \d+$/.test(alert.title)).length,
    15
  );

  console.log("Déclenchement différé, agrégation et 15 enchères simultanées validés.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
