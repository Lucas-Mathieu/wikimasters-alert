(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    thresholdSeconds: 30,
    disabledAuctionIds: [],
    auctionAlertsEnabledByDefault: true,
    auctionAlertOverrides: {}
  });

  const FALLBACK_SCAN_INTERVAL_MS = 1000;
  const MUTATION_DEBOUNCE_MS = 120;
  const MIN_MUTATION_SCAN_INTERVAL_MS = 500;
  const FORGOTTEN_AUCTION_MS = 2 * 60 * 1000;
  const auctionCycles = new Map();

  let settings = { ...DEFAULT_SETTINGS };
  let scheduledScan = null;
  let lastScanAt = 0;

  // ===== WIKIMASTERS SELECTORS =====
  // Ajouter en tête de ces listes les sélecteurs relevés dans le DOM authentifié.
  // La détection générique reste volontairement en dernier recours.
  const SELECTORS = Object.freeze({
    auctionContainers: [
      "[data-auction-id]",
      "[data-listing-id]",
      "[data-end-time]",
      "[data-expires-at]",
      "[data-testid*='auction' i]",
      "[data-testid*='enchere' i]",
      "a[href*='auction' i]",
      "a[href*='enchere' i]",
      "[class*='auction' i]",
      "[class*='enchere' i]",
      "[class*='listing' i]"
    ],
    timers: [
      "[data-countdown]",
      "[data-remaining-seconds]",
      "[data-testid*='countdown' i]",
      "[data-testid*='timer' i]",
      "[role='timer']",
      "[aria-label*='temps restant' i]",
      "[aria-label*='se termine' i]",
      "[aria-label*='countdown' i]",
      "[class*='countdown' i]",
      "[class*='timer' i]",
      "[class*='remaining' i]",
      "[class*='time-left' i]",
      "[class*='timeLeft' i]"
    ],
    titles: [
      "[data-auction-title]",
      "[data-testid*='title' i]",
      "[class*='title' i]",
      "h1",
      "h2",
      "h3",
      "h4"
    ]
  });
  // ===== END WIKIMASTERS SELECTORS =====

  const AUCTION_CONTEXT_PATTERN = /\b(?:ench[eè]res?|ench[eé]rir|auction|offres?|miser|mises?|prix actuel|bids?|vente)\b/i;
  const ACTIVE_CONTEXT_PATTERN = /\b(?:en cours|ouverte?|temps restant|reste|se termine|expire|fin dans|offres?)\b/i;
  const CLOSED_CONTEXT_PATTERN = /\b(?:termin[eé]e?|cl[oô]tur[eé]e?|ferm[eé]e?|expir[eé]e?|vendue?|annul[eé]e?)\b/i;
  const DETAIL_PAGE_MARKERS = Object.freeze({
    backToMarket: /retour\s+au\s+march[eé]/i,
    bidHistory: /historique\s+des\s+mises/i,
    currentBid: /mise\s+actuelle/i,
    timeRemaining: /temps\s+restant/i,
    bidAction: /\bmiser\b/i
  });
  const PAGE_TOGGLE_HOST_ID = "wikimasters-auction-alert-toggle";

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/[\u00a0\u202f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseCountdown(rawValue) {
    let value = normalizeText(rawValue).toLocaleLowerCase("fr");

    if (!value || value.length > 80) {
      return null;
    }

    value = value
      .replace(/^(?:(?:temps|dur[eé]e)\s+restant(?:e)?(?:\s+dans)?|reste|dans|fin\s+dans|se\s+termine\s+dans|expire(?:ra|nt)?\s+dans|countdown)\s*[:\-]?\s*/i, "")
      .replace(/\s*(?:restant(?:e)?s?)\s*$/i, "")
      .replace(/[.]$/, "")
      .trim();

    const colonMatch = value.match(/^(\d{1,3})\s*:\s*([0-5]?\d)(?:\s*:\s*([0-5]?\d))?$/);
    if (colonMatch) {
      const first = Number(colonMatch[1]);
      const second = Number(colonMatch[2]);
      const third = colonMatch[3] === undefined ? null : Number(colonMatch[3]);

      return third === null
        ? first * 60 + second
        : first * 3600 + second * 60 + third;
    }

    const unitValue = value.replace(/\s*[:·]\s*/g, " ");
    const unitsMatch = unitValue.match(
      /^(?:(\d+)\s*(?:j|jour(?:s)?)\s*)?(?:(\d+)\s*(?:h|heure(?:s)?)\s*)?(?:(\d+)\s*(?:m|min|minute(?:s)?)\s*)?(?:(\d+)\s*(?:s|sec|seconde(?:s)?)\s*)?$/i
    );

    if (!unitsMatch || !unitsMatch.slice(1).some((part) => part !== undefined)) {
      return null;
    }

    const [, days = 0, hours = 0, minutes = 0, seconds = 0] = unitsMatch;
    return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  }

  function hasExplicitTimerText(value) {
    return /(?:dans(?=\s*\d|\b)|\b(?:restant|termine|expire)\b)/i.test(normalizeText(value));
  }

  function selectorList(selectors) {
    return selectors.join(",");
  }

  function safeMatches(element, selectors) {
    try {
      return element.matches(selectorList(selectors));
    } catch {
      return false;
    }
  }

  function safeClosest(element, selectors) {
    try {
      return element.closest(selectorList(selectors));
    } catch {
      return null;
    }
  }

  function directText(element) {
    return normalizeText(
      Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join(" ")
    );
  }

  function readTimerValue(element) {
    const numericSeconds = normalizeText(element.getAttribute("data-remaining-seconds"));
    if (/^\d+$/.test(numericSeconds)) {
      return { seconds: Number(numericSeconds), sourceText: numericSeconds };
    }

    const numericCountdown = normalizeText(element.getAttribute("data-countdown"));
    if (/^\d+$/.test(numericCountdown)) {
      return { seconds: Number(numericCountdown), sourceText: numericCountdown };
    }

    const attributeValues = [numericCountdown, element.getAttribute("aria-label")];

    for (const value of attributeValues) {
      const seconds = parseCountdown(value);
      if (seconds !== null) {
        return { seconds, sourceText: normalizeText(value) };
      }
    }

    const values = [directText(element)];
    if (element.childElementCount <= 8) {
      values.push(normalizeText(element.textContent));
    }

    for (const value of values) {
      const seconds = parseCountdown(value);
      if (seconds !== null) {
        return { seconds, sourceText: value };
      }
    }

    return null;
  }

  function readEmbeddedTimerValue(element) {
    const text = normalizeText(element.textContent);
    if (!text || text.length > 320) {
      return null;
    }

    const signal = text.match(/(?:temps\s+restant(?:e)?|reste|fin\s+dans|se\s+termine\s+dans|expire(?:ra|nt)?\s+dans|dans)\s*[:\-]?\s*(.*)$/i);
    if (!signal) {
      return null;
    }

    const remainder = signal[1].replace(/^dans\s*/i, "");
    const colonDuration = remainder.match(/^(\d{1,3}\s*:\s*[0-5]?\d(?:\s*:\s*[0-5]?\d)?)/);
    const unitsDuration = remainder.match(
      /^((?:(?:\d+)\s*(?:j|jour(?:s)?|h|heure(?:s)?|m|min|minute(?:s)?|s|sec|seconde(?:s)?)\s*){1,4})/i
    );
    const durationText = colonDuration?.[1] || unitsDuration?.[1];
    const seconds = parseCountdown(durationText);

    return seconds === null ? null : { seconds, sourceText: signal[0] };
  }

  function addCandidatesFrom(root, candidates, limit = 250, allowEmbedded = false) {
    if (!(root instanceof Element || root instanceof Document)) {
      return;
    }

    if (
      root instanceof Element &&
      (readTimerValue(root) || (allowEmbedded && readEmbeddedTimerValue(root)))
    ) {
      candidates.add(root);
    }

    const elements = root.querySelectorAll(
      `${selectorList(SELECTORS.timers)}, time, span, p, div, li, [aria-label]`
    );

    for (let index = 0; index < elements.length && index < limit; index += 1) {
      if (
        readTimerValue(elements[index]) ||
        (allowEmbedded && readEmbeddedTimerValue(elements[index]))
      ) {
        candidates.add(elements[index]);
      }
    }
  }

  function pageText() {
    return normalizeText(document.body?.innerText || document.body?.textContent).slice(0, 60000);
  }

  function isAuctionDetailPage(text = pageText()) {
    const hasBackLink = DETAIL_PAGE_MARKERS.backToMarket.test(text);
    const hasPageStructure = hasBackLink && DETAIL_PAGE_MARKERS.bidHistory.test(text);
    const hasAuctionPanel =
      hasBackLink &&
      DETAIL_PAGE_MARKERS.currentBid.test(text) &&
      DETAIL_PAGE_MARKERS.timeRemaining.test(text) &&
      DETAIL_PAGE_MARKERS.bidAction.test(text);

    return hasPageStructure || hasAuctionPanel;
  }

  function findContextContainer(timerElement, detailPage) {
    const explicitContainer = safeClosest(timerElement, SELECTORS.auctionContainers);
    if (explicitContainer) {
      return { element: explicitContainer, explicit: true, detailPage };
    }

    let current = timerElement.parentElement;
    let depth = 0;

    let timePanel = null;
    while (current && current !== document.body && depth < 12) {
      const fullText = normalizeText(current.textContent);
      const text = fullText.slice(0, 1800);
      if (
        detailPage &&
        fullText.length <= 900 &&
        DETAIL_PAGE_MARKERS.timeRemaining.test(text)
      ) {
        timePanel = current;
      }
      if (AUCTION_CONTEXT_PATTERN.test(text)) {
        return {
          element: current,
          explicit: false,
          detailPage,
          nearTimeRemaining: Boolean(timePanel)
        };
      }
      current = current.parentElement;
      depth += 1;
    }

    if (detailPage) {
      return {
        element: timePanel || document.querySelector("main") || document.body,
        explicit: false,
        detailPage: true,
        nearTimeRemaining: Boolean(timePanel)
      };
    }

    return null;
  }

  function isCredibleAuctionTimer(timerElement, timer, context, detailPageText) {
    if (!context) {
      return false;
    }

    const contextText = normalizeText(context.element.textContent).slice(0, 2200);
    if (CLOSED_CONTEXT_PATTERN.test(contextText)) {
      return false;
    }

    const semanticTimer = safeMatches(timerElement, SELECTORS.timers);
    const explicitTimerText = hasExplicitTimerText(timer.sourceText);
    if (context.detailPage && !context.nearTimeRemaining && !semanticTimer && !explicitTimerText) {
      return false;
    }

    let confidence = 0;
    if (context.explicit) confidence += 3;
    if (AUCTION_CONTEXT_PATTERN.test(contextText)) confidence += 3;
    if (ACTIVE_CONTEXT_PATTERN.test(contextText)) confidence += 2;
    if (semanticTimer) confidence += 2;
    if (timerElement.hasAttribute("data-countdown") || timerElement.getAttribute("role") === "timer") {
      confidence += 2;
    }
    if (
      context.detailPage &&
      DETAIL_PAGE_MARKERS.currentBid.test(detailPageText) &&
      DETAIL_PAGE_MARKERS.timeRemaining.test(detailPageText)
    ) {
      confidence += 4;
    }

    return confidence >= 5;
  }

  function isUsableAuctionTitle(element, timerElement) {
    const title = normalizeText(element?.textContent);
    return Boolean(
      title &&
      title.length <= 160 &&
      element !== timerElement &&
      parseCountdown(title) === null &&
      !/^(?:ench[eè]re|auction)(?:\s+en\s+cours)?$/i.test(title)
    );
  }

  function findAuctionTitle(container, timerElement, detailPage) {
    for (const selector of SELECTORS.titles) {
      const elements = container.querySelectorAll(selector);
      for (const element of elements) {
        if (isUsableAuctionTitle(element, timerElement)) {
          return normalizeText(element.textContent);
        }
      }
    }

    if (detailPage) {
      for (const element of document.querySelectorAll("main h1, main h2, h1, h2")) {
        if (isUsableAuctionTitle(element, timerElement)) {
          return normalizeText(element.textContent);
        }
      }
    }

    return normalizeText(document.title.replace(/\s*[|–—-]\s*WikiMasters.*$/i, "")) || "Enchère WikiMasters";
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function stableElementPath(element) {
    const parts = [];
    let current = element;

    while (current && current !== document.body && parts.length < 7) {
      let siblingIndex = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) siblingIndex += 1;
        sibling = sibling.previousElementSibling;
      }

      parts.push(`${current.tagName.toLocaleLowerCase()}:nth-of-type(${siblingIndex})`);
      current = current.parentElement;
    }

    return parts.reverse().join(">");
  }

  function findAuctionId(container, timerElement, title, detailPage) {
    const idAttributes = [
      "data-auction-id",
      "data-id",
      "data-listing-id",
      "data-testid"
    ];

    for (const element of [container, timerElement]) {
      for (const attribute of idAttributes) {
        const value = normalizeText(element.getAttribute(attribute));
        if (value) {
          return `${attribute}:${value}`;
        }
      }
    }

    if (detailPage && location.pathname !== "/") {
      return `page:${location.pathname}${location.search}`;
    }

    const auctionLink = container.querySelector("a[href*='auction' i], a[href*='enchere' i]");
    if (auctionLink?.href) {
      try {
        const url = new URL(auctionLink.href, location.href);
        return `url:${url.pathname}${url.search}`;
      } catch {
        // Une URL relative inhabituelle ne doit pas interrompre la surveillance.
      }
    }

    const structuralHint = [
      location.pathname,
      title,
      container.id,
      normalizeText(container.getAttribute("class")).slice(0, 180),
      stableElementPath(container)
    ].join("|");

    return `generated:${hashString(structuralHint)}`;
  }

  function findActiveAuctions() {
    const candidates = new Set();
    const detailPageText = pageText();
    const detailPage = isAuctionDetailPage(detailPageText);
    const containerSelector = selectorList(SELECTORS.auctionContainers);
    const explicitContainers = document.querySelectorAll(containerSelector);

    for (let index = 0; index < explicitContainers.length && index < 100; index += 1) {
      addCandidatesFrom(explicitContainers[index], candidates, 160);
    }

    for (const timer of document.querySelectorAll(selectorList(SELECTORS.timers))) {
      candidates.add(timer);
      if (candidates.size >= 300) break;
    }

    // Repli générique borné pour les interfaces sans attribut ou classe sémantique.
    if (candidates.size < 20 || detailPage) {
      addCandidatesFrom(document, candidates, detailPage ? 4000 : 1600, detailPage);
    }

    const auctionsById = new Map();

    for (const element of candidates) {
      const timer = readTimerValue(element) || (detailPage ? readEmbeddedTimerValue(element) : null);
      if (!timer || timer.seconds <= 0) {
        continue;
      }

      const context = findContextContainer(element, detailPage);
      if (!isCredibleAuctionTimer(element, timer, context, detailPageText)) {
        continue;
      }

      const title = findAuctionTitle(context.element, element, context.detailPage);
      const id = findAuctionId(context.element, element, title, detailPage);
      const auction = {
        id,
        title,
        secondsRemaining: timer.seconds,
        element
      };

      const previous = auctionsById.get(id);
      if (!previous || auction.secondsRemaining < previous.secondsRemaining) {
        auctionsById.set(id, auction);
      }
    }

    return Array.from(auctionsById.values());
  }

  function normalizedOverrides() {
    return settings.auctionAlertOverrides && typeof settings.auctionAlertOverrides === "object"
      ? settings.auctionAlertOverrides
      : {};
  }

  function isAuctionAlertEnabled(auctionId) {
    const overrides = normalizedOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, auctionId)) {
      return overrides[auctionId] !== false;
    }

    if (Array.isArray(settings.disabledAuctionIds) && settings.disabledAuctionIds.includes(auctionId)) {
      return false;
    }

    return settings.auctionAlertsEnabledByDefault !== false;
  }

  async function storeAuctionOverride(auctionId, enabled) {
    const stored = await chrome.storage.local.get({ auctionAlertOverrides: {} });
    const overrides = stored.auctionAlertOverrides && typeof stored.auctionAlertOverrides === "object"
      ? { ...stored.auctionAlertOverrides }
      : {};
    overrides[auctionId] = Boolean(enabled);

    const entries = Object.entries(overrides).slice(-500);
    await chrome.storage.local.set({ auctionAlertOverrides: Object.fromEntries(entries) });
  }

  function removePageAuctionToggle() {
    document.getElementById(PAGE_TOGGLE_HOST_ID)?.remove();
  }

  function updatePageAuctionToggle(activeAuctions) {
    if (!isAuctionDetailPage() || activeAuctions.length === 0) {
      removePageAuctionToggle();
      return;
    }

    const auction = activeAuctions.reduce((closest, current) =>
      current.secondsRemaining < closest.secondsRemaining ? current : closest
    );
    let host = document.getElementById(PAGE_TOGGLE_HOST_ID);

    if (!host) {
      host = document.createElement("div");
      host.id = PAGE_TOGGLE_HOST_ID;
      host.setAttribute("data-wikimasters-alert-ui", "true");
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        :host { position: fixed; right: 22px; bottom: 22px; z-index: 2147483647; color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .card { display: flex; width: 286px; align-items: center; gap: 12px; padding: 13px 14px; border: 1px solid rgba(255, 255, 255, 0.13); border-radius: 15px; color: #f7f8fc; background: rgba(23, 27, 38, 0.96); box-shadow: 0 16px 42px rgba(0, 0, 0, 0.42); backdrop-filter: blur(12px); }
        .mark { display: grid; flex: 0 0 auto; width: 36px; height: 36px; place-items: center; border-radius: 11px; color: #fff; background: linear-gradient(145deg, #5665f5, #754bd9); font-size: 18px; font-weight: 900; }
        .copy { min-width: 0; flex: 1; }
        .label, .title { display: block; }
        .label { font-size: 12px; font-weight: 800; }
        .title { margin-top: 3px; overflow: hidden; color: #aeb5c5; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
        input { position: relative; flex: 0 0 auto; width: 40px; height: 23px; margin: 0; border: 0; border-radius: 999px; appearance: none; background: #555d70; cursor: pointer; transition: background 150ms ease; }
        input::after { position: absolute; top: 3px; left: 3px; width: 17px; height: 17px; border-radius: 50%; background: #fff; content: ""; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35); transition: transform 150ms ease; }
        input:checked { background: #5e67ed; }
        input:checked::after { transform: translateX(17px); }
        input:focus-visible { outline: 3px solid rgba(113, 122, 255, 0.38); outline-offset: 3px; }
      `;

      const card = document.createElement("label");
      card.className = "card";
      const mark = document.createElement("span");
      mark.className = "mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "W";
      const copy = document.createElement("span");
      copy.className = "copy";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = "Alerte pour cette enchère";
      const title = document.createElement("span");
      title.className = "title";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", "Activer l’alerte pour cette enchère");

      copy.append(label, title);
      card.append(mark, copy, toggle);
      shadow.append(style, card);

      toggle.addEventListener("change", async () => {
        toggle.disabled = true;
        try {
          await storeAuctionOverride(host.dataset.auctionId, toggle.checked);
        } catch (error) {
          console.error("WikiMasters Alert: réglage de l’enchère impossible", error);
          toggle.checked = !toggle.checked;
        } finally {
          toggle.disabled = false;
        }
      });
      document.documentElement.append(host);
    }

    host.dataset.auctionId = auction.id;
    const shadow = host.shadowRoot;
    shadow.querySelector(".title").textContent = auction.title;
    shadow.querySelector("input").checked = isAuctionAlertEnabled(auction.id);
  }

  function cycleForAuction(auction, now) {
    const estimatedEndAt = now + auction.secondsRemaining * 1000;
    const previous = auctionCycles.get(auction.id);
    const timerJumpedForward = previous && auction.secondsRemaining > previous.lastSeconds + 10;
    const endTimeChanged = previous && Math.abs(estimatedEndAt - previous.estimatedEndAt) > 15000;

    if (!previous || timerJumpedForward || endTimeChanged) {
      const cycle = {
        estimatedEndAt,
        lastSeconds: auction.secondsRemaining,
        lastSeenAt: now,
        alerted: false
      };
      auctionCycles.set(auction.id, cycle);
      return cycle;
    }

    previous.estimatedEndAt = Math.round((previous.estimatedEndAt * 3 + estimatedEndAt) / 4);
    previous.lastSeconds = auction.secondsRemaining;
    previous.lastSeenAt = now;
    return previous;
  }

  function sendThresholdAlert(auction, cycle) {
    cycle.alerted = true;

    chrome.runtime.sendMessage(
      {
        type: "AUCTION_THRESHOLD_REACHED",
        auction: {
          id: auction.id,
          title: auction.title,
          secondsRemaining: auction.secondsRemaining,
          cycleId: `${auction.id}:${Math.round(cycle.estimatedEndAt / 10000)}`,
          pageUrl: location.href
        }
      },
      () => {
        if (chrome.runtime.lastError) {
          console.debug("WikiMasters Alert: service worker indisponible", chrome.runtime.lastError.message);
        }
      }
    );
  }

  function scanPage() {
    scheduledScan = null;
    lastScanAt = Date.now();
    if (!settings.enabled) {
      return;
    }

    const now = Date.now();
    const activeAuctions = findActiveAuctions();
    lastScanResult = {
      scannedAt: now,
      auctions: activeAuctions.map(({ id, title, secondsRemaining }) => ({
        id,
        title,
        secondsRemaining,
        enabled: isAuctionAlertEnabled(id)
      }))
    };

    try {
      updatePageAuctionToggle(activeAuctions);
    } catch (error) {
      console.error("WikiMasters Alert: affichage du toggle impossible", error);
    }

    for (const auction of activeAuctions) {
      if (!isAuctionAlertEnabled(auction.id)) {
        auctionCycles.delete(auction.id);
        continue;
      }

      const cycle = cycleForAuction(auction, now);
      if (!cycle.alerted && auction.secondsRemaining <= settings.thresholdSeconds) {
        sendThresholdAlert(auction, cycle);
      }
    }

    for (const [id, cycle] of auctionCycles) {
      if (now - cycle.lastSeenAt > FORGOTTEN_AUCTION_MS) {
        auctionCycles.delete(id);
      }
    }
  }

  function scheduleScan() {
    if (!settings.enabled || scheduledScan !== null) {
      return;
    }

    const elapsedSinceLastScan = Date.now() - lastScanAt;
    const delay = Math.max(
      MUTATION_DEBOUNCE_MS,
      MIN_MUTATION_SCAN_INTERVAL_MS - elapsedSinceLastScan
    );
    scheduledScan = window.setTimeout(scanPage, delay);
  }

  async function initialize() {
    settings = await chrome.storage.local.get(DEFAULT_SETTINGS);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      let shouldScan = false;
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (changes[key]) {
          settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
          shouldScan = true;
        }
      }

      if (!settings.enabled) {
        auctionCycles.clear();
        removePageAuctionToggle();
      } else if (shouldScan) {
        scheduleScan();
      }
    });

    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "class",
        "data-countdown",
        "data-remaining-seconds"
      ]
    });

    window.setInterval(scanPage, FALLBACK_SCAN_INTERVAL_MS);
    scanPage();
  }

  let lastScanResult = {
    scannedAt: null,
    auctions: []
  };

  if (typeof globalThis.__WIKIMASTERS_TEST_HOOK__ === "function") {
    globalThis.__WIKIMASTERS_TEST_HOOK__({
      hashString,
      hasExplicitTimerText,
      isAuctionDetailPage,
      parseCountdown,
      readEmbeddedTimerValue
    });
  } else {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GET_MONITOR_STATUS") {
        return false;
      }

      sendResponse({
        ok: true,
        enabled: settings.enabled,
        thresholdSeconds: settings.thresholdSeconds,
        ...lastScanResult
      });
      return false;
    });

    initialize().catch((error) => {
      console.error("WikiMasters Alert: initialisation impossible", error);
    });
  }
})();
