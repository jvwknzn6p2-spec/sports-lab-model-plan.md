import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecrets, redactUrl, scrubSecrets, SecretLeakError } from "../src/redact";

test("redactUrl strips credential-shaped query params", () => {
  const url = "https://api.the-odds-api.com/v4/sports/?apiKey=SECRET123&all=true";
  const out = redactUrl(url);
  assert.ok(!out.includes("SECRET123"));
  assert.ok(out.includes("apiKey=%3Credacted%3E") || out.includes("apiKey=<redacted>"));
  assert.ok(out.includes("all=true"), "non-credential params survive");
});

test("redactUrl covers api_token (Sportmonks style)", () => {
  const out = redactUrl("https://api.sportmonks.com/v3/football/leagues?api_token=TOK_abc");
  assert.ok(!out.includes("TOK_abc"));
});

test("redactUrl never throws on garbage", () => {
  assert.equal(redactUrl("not a url"), "<unparseable-url>");
});

test("scrubSecrets removes every occurrence", () => {
  const out = scrubSecrets("a SECRET b SECRET c", ["SECRET"]);
  assert.equal(out, "a <redacted> b <redacted> c");
});

test("assertNoSecrets throws without echoing the secret", () => {
  let caught: unknown;
  try {
    assertNoSecrets('{"token":"TOPSECRET"}', ["TOPSECRET"], "test payload");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof SecretLeakError);
  assert.ok(!(caught as Error).message.includes("TOPSECRET"));
});

test("assertNoSecrets passes clean text and ignores empty secrets", () => {
  assertNoSecrets("clean", ["", "SECRET"], "ctx");
});
