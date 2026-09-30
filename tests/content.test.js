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

const validCases = new Map([
  ["00:32", 32],
  ["0:32", 32],
  ["02 : 14 : 09", 8049],
  ["32s", 32],
  ["32 sec", 32],
  ["1m 20s", 80],
  ["Temps restant : 01:05", 65],
  ["se termine dans 2 min 05 sec", 125],
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
