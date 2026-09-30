"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let permissionLevel = "granted";
let createdNotification = null;
let sessionStore = {};

const listeners = {
  installed: null,
  message: null,
  notificationClicked: null,
  notificationClosed: null
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
  notifications: {
    getPermissionLevel: async () => permissionLevel,
    create: async (id, options) => {
      createdNotification = { id, options };
      return id;
    },
    clear: async () => true,
    onClicked: { addListener: (listener) => { listeners.notificationClicked = listener; } },
    onClosed: { addListener: (listener) => { listeners.notificationClosed = listener; } }
  },
  storage: {
    local: {
      get: async () => ({
        enabled: true,
        showNotification: true,
        playSound: false,
        bringToFront: false,
        thresholdSeconds: 40
      }),
      set: async () => {}
    },
    session: {
      get: async (key) => ({ [key]: sessionStore[key] }),
      set: async (values) => { sessionStore = { ...sessionStore, ...values }; }
    }
  },
  tabs: {
    query: async () => [wikiTab],
    get: async () => wikiTab,
    update: async () => wikiTab
  },
  windows: {
    update: async () => ({})
  },
  offscreen: {
    createDocument: async () => {}
  }
};

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const testConsole = { ...console, error: () => {} };
const context = vm.createContext({ chrome, console: testConsole, URL, self: { clients: { matchAll: async () => [] } } });
vm.runInContext(source, context, { filename: "background.js" });

(async () => {
  const success = await vm.runInContext("handleTestAlert()", context);
  assert.equal(success.channels.notification.ok, true);
  assert.equal(createdNotification.options.type, "basic");
  assert.equal(createdNotification.options.requireInteraction, true);
  assert.match(createdNotification.options.title, /Test/);

  permissionLevel = "denied";
  const denied = await vm.runInContext("handleTestAlert()", context);
  assert.equal(denied.channels.notification.ok, false);
  assert.match(denied.channels.notification.error, /non autorisées/);

  assert.ok(listeners.message, "Le service worker doit écouter les messages");
  assert.ok(listeners.notificationClicked, "Le clic sur notification doit être géré");

  console.log("Canal de notification et diagnostic de permission validés.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
