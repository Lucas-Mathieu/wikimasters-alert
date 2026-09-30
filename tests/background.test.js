"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let customWindowError = null;
let createdWindow = null;
let sessionStore = {};

const listeners = {
  installed: null,
  message: null,
  windowRemoved: null
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
    create: async (options) => {
      if (customWindowError) throw customWindowError;
      createdWindow = { id: 81, options };
      return { id: 81 };
    },
    update: async () => ({}),
    onRemoved: { addListener: (listener) => { listeners.windowRemoved = listener; } }
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

  console.log("Fenêtre d’alerte Chrome et gestion d’erreur validées.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
