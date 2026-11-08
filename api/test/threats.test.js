import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Keeps THREATS.md honest: every test it names must exist, and every THREAT test must be listed.
const threatsDoc = readFileSync(new URL("../../THREATS.md", import.meta.url), "utf8");
const testDir = new URL("./", import.meta.url);

const titles = readdirSync(testDir)
  .filter((file) => file.endsWith(".test.js"))
  .flatMap((file) => {
    const source = readFileSync(new URL(file, testDir), "utf8");
    const found = [...source.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
    assert.equal(found.length, [...source.matchAll(/^test\(/gm)].length, `${file}: every test needs a plain string title`);
    return found;
  });

// Each table row names its proving tests as `backticked` spans in the last cell.
// "..." inside a span stands for words left out; every part must appear in one title.
const rows = threatsDoc
  .split("\n")
  .filter((line) => line.startsWith("|") && !/^\|[-| ]+\|$/.test(line) && !line.startsWith("| Threat |"))
  .map((line) => {
    const cells = line.split("|");
    const testCell = cells[cells.length - 2];
    return { threat: cells[1].trim(), spans: [...testCell.matchAll(/`([^`]+)`/g)].map((m) => m[1]) };
  });

const partsOf = (span) => span.split(/\s*\.\.\.\s*/).filter(Boolean);

test("THREATS.md lists threats, and each one names at least one test", () => {
  assert.ok(rows.length >= 30, `expected many threat rows, found ${rows.length}`);
  for (const row of rows) assert.ok(row.spans.length > 0, `no test named for: ${row.threat}`);
});

test("every test named in THREATS.md exists", () => {
  for (const row of rows) {
    for (const span of row.spans) {
      const exists = titles.some((title) => partsOf(span).every((part) => title.includes(part)));
      assert.ok(exists, `THREATS.md names a test that does not exist: "${span}" (threat: ${row.threat})`);
    }
  }
});

test("every THREAT test is listed in THREATS.md", () => {
  const named = rows.flatMap((row) => row.spans.flatMap(partsOf));
  const missing = titles.filter((title) => title.startsWith("THREAT ") && !named.some((part) => title.includes(part)));
  assert.deepEqual(missing, []);
});
