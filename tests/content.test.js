"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let detector;
const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const context = vm.createContext({
  URL,
  console,
  __WIKIMASTERS_TEST_HOOK__(api) {
    detector = api;
  }
});

vm.runInContext(source, context, { filename: "content.js" });
assert.ok(detector, "Le point d’entrée de test doit exposer le parseur");

const detailPageText = `
  Retour au marché
  Mise actuelle 230
  Temps restant dans 19m 49s
  Miser
  Historique des mises (1)
`;
assert.equal(detector.isAuctionDetailPage(detailPageText), true);
assert.equal(detector.isAuctionDetailPage("Marché Toutes les cartes Profil"), false);
assert.equal(detector.hasExplicitTimerText("dans 19m 49s"), true);
assert.equal(detector.hasExplicitTimerText("09:35"), false);
assert.equal(detector.indicatesClosedAuction("Se termine dans 22m 12s"), false);
assert.equal(
  detector.indicatesClosedAuction("Mise actuelle150Temps restantSe termine dans 22m 12s"),
  false
);
assert.equal(detector.indicatesClosedAuction("Expire dans 49s"), false);
assert.equal(detector.indicatesClosedAuction("Enchère terminée"), true);
assert.equal(detector.isUsableAuctionTitle({ textContent: "WikiMasters" }, {}), false);
assert.equal(detector.isUsableAuctionTitle({ textContent: "Yakuza 5" }, {}), true);

const initialCycle = detector.cycleForAuction(
  { id: "minimized-auction", secondsRemaining: 120 },
  1_000_000
);
const frozenTimerCycle = detector.cycleForAuction(
  { id: "minimized-auction", secondsRemaining: 120 },
  1_060_000
);
assert.equal(frozenTimerCycle.cycleId, initialCycle.cycleId);
assert.equal(frozenTimerCycle.estimatedEndAt, initialCycle.estimatedEndAt);

const extendedCycle = detector.cycleForAuction(
  { id: "minimized-auction", secondsRemaining: 180 },
  1_061_000
);
assert.notEqual(extendedCycle.cycleId, initialCycle.cycleId);
assert.equal(extendedCycle.estimatedEndAt, 1_241_000);
assert.deepEqual(
  JSON.parse(JSON.stringify(detector.readEmbeddedTimerValue({ textContent: "Mise 60 · dans 1m 11s" }))),
  { seconds: 71, sourceText: "dans 1m 11s" }
);
assert.equal(
  detector.readEmbeddedTimerValue({ textContent: "Mise60dans1m11s" }).seconds,
  71
);
assert.equal(detector.readEmbeddedTimerValue({ textContent: "30 sept., 09:35" }), null);

const timerElement = { textContent: "Se termine dans 22m 12s" };
const labelElement = { textContent: "Temps restant", parentElement: null };
const timerRow = { children: [labelElement, timerElement] };
labelElement.parentElement = timerRow;
const fixtureRoot = {
  querySelectorAll(selector) {
    assert.equal(selector, "span");
    return [labelElement, timerElement];
  }
};
const labeledTimers = detector.findLabeledCountdownElements(fixtureRoot);
assert.equal(labeledTimers.length, 1);
assert.equal(labeledTimers[0], timerElement);

const auctionFixture = fs.readFileSync(
  path.join(__dirname, "fixtures", "auction-detail.html"),
  "utf8"
);
const fixtureTimerText = auctionFixture.match(
  /<span class="tabular-nums font-medium">([^<]+)<\/span>/
)?.[1];
assert.equal(fixtureTimerText, "Se termine dans 22m 12s");
assert.equal(detector.parseCountdown(fixtureTimerText), 1332);

const validCases = new Map([
  ["00:32", 32],
  ["0:32", 32],
  ["02 : 14 : 09", 8049],
  ["32s", 32],
  ["32 sec", 32],
  ["1m 20s", 80],
  ["Temps restant : 01:05", 65],
  ["se termine dans 2 min 05 sec", 125],
  ["expire dans 40 secondes", 40],
  ["dans 19m 49s", 1189],
  ["Temps restant dans 1m 11s", 71],
  ["00 h : 00 min : 40 s", 40],
  ["1 h 2 min 3 sec", 3723],
  ["1 jour 2 h", 93600]
]);

for (const [input, expected] of validCases) {
  assert.equal(detector.parseCountdown(input), expected, `Parsing de « ${input} »`);
}

for (const input of ["", "1 240", "7 offres", "enchère terminée", "12:98", "12"]) {
  assert.equal(detector.parseCountdown(input), null, `Rejet de « ${input} »`);
}

assert.equal(detector.hashString("auction-42"), detector.hashString("auction-42"));
assert.notEqual(detector.hashString("auction-42"), detector.hashString("auction-43"));

console.log(`${validCases.size + 6} cas de compte à rebours validés.`);
