(() => {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    thresholdSeconds: 30
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
      "[data-testid*='auction' i]",
      "[data-testid*='enchere' i]",
      "[class*='auction' i]",
      "[class*='enchere' i]"
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
      "[class*='remaining' i]"
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

  const AUCTION_CONTEXT_PATTERN = /\b(?:ench[eè]re|auction|offre|miser|mise actuelle|bid)\b/i;
  const ACTIVE_CONTEXT_PATTERN = /\b(?:en cours|ouverte?|temps restant|se termine|fin dans|offres?)\b/i;
  const CLOSED_CONTEXT_PATTERN = /\b(?:termin[eé]e?|cl[oô]tur[eé]e?|ferm[eé]e?|expir[eé]e?|vendue?|annul[eé]e?)\b/i;

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
      .replace(/^(?:(?:temps|dur[eé]e)\s+restant(?:e)?|reste|fin\s+dans|se\s+termine\s+dans|countdown)\s*[:\-]?\s*/i, "")
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

    const unitsMatch = value.match(
      /^(?:(\d+)\s*(?:j|jour(?:s)?)\s*)?(?:(\d+)\s*(?:h|heure(?:s)?)\s*)?(?:(\d+)\s*(?:m|min|minute(?:s)?)\s*)?(?:(\d+)\s*(?:s|sec|seconde(?:s)?)\s*)?$/i
    );

    if (!unitsMatch || !unitsMatch.slice(1).some((part) => part !== undefined)) {
      return null;
    }

    const [, days = 0, hours = 0, minutes = 0, seconds = 0] = unitsMatch;
    return Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
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

  function addCandidatesFrom(root, candidates, limit = 250) {
    if (!(root instanceof Element || root instanceof Document)) {
      return;
    }

    if (root instanceof Element && readTimerValue(root)) {
      candidates.add(root);
    }

    const elements = root.querySelectorAll(
      `${selectorList(SELECTORS.timers)}, time, span, p, [aria-label]`
    );

    for (let index = 0; index < elements.length && index < limit; index += 1) {
      if (readTimerValue(elements[index])) {
        candidates.add(elements[index]);
      }
    }
  }

  function findContextContainer(timerElement) {
    const explicitContainer = safeClosest(timerElement, SELECTORS.auctionContainers);
    if (explicitContainer) {
      return { element: explicitContainer, explicit: true };
    }

    let current = timerElement.parentElement;
    let depth = 0;

    while (current && current !== document.body && depth < 7) {
      const text = normalizeText(current.textContent).slice(0, 1800);
      if (AUCTION_CONTEXT_PATTERN.test(text)) {
        return { element: current, explicit: false };
      }
      current = current.parentElement;
      depth += 1;
    }

    return null;
  }

  function isCredibleAuctionTimer(timerElement, context) {
    if (!context) {
      return false;
    }

    const contextText = normalizeText(context.element.textContent).slice(0, 2200);
    if (CLOSED_CONTEXT_PATTERN.test(contextText)) {
      return false;
    }

    let confidence = 0;
    if (context.explicit) confidence += 3;
    if (AUCTION_CONTEXT_PATTERN.test(contextText)) confidence += 3;
    if (ACTIVE_CONTEXT_PATTERN.test(contextText)) confidence += 2;
    if (safeMatches(timerElement, SELECTORS.timers)) confidence += 2;
    if (timerElement.hasAttribute("data-countdown") || timerElement.getAttribute("role") === "timer") {
      confidence += 2;
    }

    return confidence >= 5;
  }

  function findAuctionTitle(container, timerElement) {
    for (const selector of SELECTORS.titles) {
      const elements = container.querySelectorAll(selector);
      for (const element of elements) {
        const title = normalizeText(element.textContent);
        if (
          title &&
          title.length <= 160 &&
          element !== timerElement &&
          parseCountdown(title) === null &&
          !/^(?:ench[eè]re|auction)(?:\s+en\s+cours)?$/i.test(title)
        ) {
          return title;
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

  function findAuctionId(container, timerElement, title) {
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
    if (candidates.size < 20) {
      addCandidatesFrom(document, candidates, 1600);
    }

    const auctionsById = new Map();

    for (const element of candidates) {
      const timer = readTimerValue(element);
      if (!timer || timer.seconds <= 0) {
        continue;
      }

      const context = findContextContainer(element);
      if (!isCredibleAuctionTimer(element, context)) {
        continue;
      }

      const title = findAuctionTitle(context.element, element);
      const id = findAuctionId(context.element, element, title);
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

    for (const auction of activeAuctions) {
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

  if (typeof globalThis.__WIKIMASTERS_TEST_HOOK__ === "function") {
    globalThis.__WIKIMASTERS_TEST_HOOK__({ hashString, parseCountdown });
  } else {
    initialize().catch((error) => {
      console.error("WikiMasters Alert: initialisation impossible", error);
    });
  }
})();
