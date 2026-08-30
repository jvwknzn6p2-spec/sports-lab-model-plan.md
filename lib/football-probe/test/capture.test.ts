import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureStore, sha256Hex } from "../src/capture";

const baseMeta = {
  provider: "test",
  endpoint: "/x/{id}",
  method: "GET",
  requestedAt: "2026-08-30T00:00:00.000Z",
  respondedAt: "2026-08-30T00:00:01.000Z",
  status: 200 as const,
};

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "fbprobe-"));
}

test("a run directory can be created exactly once", () => {
  const root = freshRoot();
  new CaptureStore(root, "run-1", []);
  assert.throws(() => new CaptureStore(root, "run-1", []), /immutable/);
});

test("a capture name can be saved exactly once (raw snapshots immutable)", () => {
  const store = new CaptureStore(freshRoot(), "run-1", []);
  store.save({ ...baseMeta, name: "a.json", url: "https://x.test/a" }, "{}");
  assert.throws(() => store.save({ ...baseMeta, name: "a.json", url: "https://x.test/a" }, "{}"), /immutable/);
});

test("manifest sha256 matches the stored bytes", () => {
  const store = new CaptureStore(freshRoot(), "run-1", []);
  const body = '{"data":[1,2,3]}';
  const cap = store.save({ ...baseMeta, name: "a.json", url: "https://x.test/a" }, body);
  const onDisk = readFileSync(join(store.dir, "a.json"), "utf8");
  assert.equal(cap.meta.sha256, sha256Hex(onDisk));
  const manifest = readFileSync(join(store.dir, "manifest.ndjson"), "utf8").trim();
  assert.equal(JSON.parse(manifest).sha256, cap.meta.sha256);
});

test("credentials never reach disk: query param redacted, body scrubbed", () => {
  const store = new CaptureStore(freshRoot(), "run-1", ["MYKEY123"]);
  const cap = store.save(
    { ...baseMeta, name: "a.json", url: "https://x.test/a?apiKey=MYKEY123" },
    '{"echo":"MYKEY123"}',
  );
  assert.ok(!cap.meta.url.includes("MYKEY123"));
  const stored = readFileSync(join(store.dir, "a.json"), "utf8");
  assert.ok(!stored.includes("MYKEY123"));
  const manifest = readFileSync(join(store.dir, "manifest.ndjson"), "utf8");
  assert.ok(!manifest.includes("MYKEY123"));
});

test("a secret in an unredactable position fails closed (nothing written)", () => {
  const store = new CaptureStore(freshRoot(), "run-1", ["MYKEY123"]);
  // Secret embedded in the URL path — redactUrl cannot strip it, the hard
  // assert must refuse the write.
  assert.throws(
    () => store.save({ ...baseMeta, name: "a.json", url: "https://x.test/MYKEY123/a" }, "{}"),
    /refusing to write/,
  );
});
