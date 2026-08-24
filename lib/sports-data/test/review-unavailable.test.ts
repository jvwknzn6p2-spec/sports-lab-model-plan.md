/**
 * An account with no credits is the reviewer being UNAVAILABLE, not a broken
 * pipeline — and that distinction decides whether the daily run goes red.
 *
 * The reviewer panel is advisory-only (model-plan §4.5): it runs after the
 * lock and changes no pick, so a day without a briefing loses nothing that
 * money rides on. Credit exhaustion is also a standing condition — it will
 * fail identically every day until somebody buys credits — so failing hard on
 * it paints every run red for something no code change can fix, and buries
 * the failures that do mean something.
 *
 * Everything else still throws. These tests pin both halves of that line,
 * against the exact wording a real run returned
 * (req_011CeLVWQtUav3RT3EA3ivA4, 2026-08-23).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isBillingUnavailable } from "../src/cli/handiedge";

/** The verbatim message the API returned on the live run. */
const REAL_BILLING_ERROR =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"Your credit balance is too low to access the Anthropic API. Please go ' +
  'to Plans & Billing to upgrade or purchase credits."},"request_id":' +
  '"req_011CeLVWQtUav3RT3EA3ivA4"}';

test("the real credit-exhaustion error is recognised", () => {
  assert.equal(isBillingUnavailable(new Error(REAL_BILLING_ERROR)), true);
  // The SDK surfaces some failures as bare strings.
  assert.equal(isBillingUnavailable(REAL_BILLING_ERROR), true);
});

test("failures that are NOT about paying still throw", () => {
  // Each of these is either fixable misconfiguration or worth retrying, and
  // a clean exit would hide it.
  const mustThrow = [
    '401 {"type":"error","error":{"type":"authentication_error",' +
      '"message":"invalid x-api-key"}}',
    '429 {"type":"error","error":{"type":"rate_limit_error",' +
      '"message":"Number of requests has exceeded your rate limit"}}',
    '500 {"type":"error","error":{"type":"api_error",' +
      '"message":"Internal server error"}}',
    // A malformed request is the SAME status and type as the billing error —
    // this is exactly why the check reads the message, not the status.
    '400 {"type":"error","error":{"type":"invalid_request_error",' +
      '"message":"max_tokens: must be greater than 0"}}',
    "fetch failed",
  ];
  for (const message of mustThrow) {
    assert.equal(
      isBillingUnavailable(new Error(message)),
      false,
      `must stay loud: ${message}`,
    );
  }
});

test("a non-Error throw is not mistaken for a billing problem", () => {
  for (const value of [undefined, null, 400, {}, []]) {
    assert.equal(isBillingUnavailable(value), false, String(value));
  }
});
