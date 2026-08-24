/**
 * A mangled credential must name itself, not the transport.
 *
 * The Anthropic SDK sends the key as an `x-api-key` header, and a header
 * value must be a ByteString. A key carrying anything else dies inside
 * `fetch` with a message that names neither the key nor the variable — a real
 * 2026-08-23 run reported only:
 *
 *   Cannot convert argument to a ByteString because the character at index 79
 *   has a value of 1061 which is greater than 255
 *
 * 1061 is U+0425 (Cyrillic Х), a perfect lookalike for Latin X: invisible in
 * the GitHub secret UI and unfindable by eye. These tests pin the preflight
 * that turns that into a sentence an operator can act on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { assertCredentialIsHeaderSafe } from "../src/cli/handiedge";

const GOOD = "sk-ant-api03-" + "a".repeat(80) + "-AA";

test("a plain-ASCII key passes", () => {
  assertCredentialIsHeaderSafe({ ANTHROPIC_API_KEY: GOOD });
  // Absent credentials are not this check's business — cmdReview skips first.
  assertCredentialIsHeaderSafe({});
});

test("a lookalike Cyrillic character is caught, and located", () => {
  // The exact failure from the live run: Latin X replaced by U+0425.
  const mangled = GOOD.slice(0, 40) + "Х" + GOOD.slice(41);
  assert.throws(
    () => assertCredentialIsHeaderSafe({ ANTHROPIC_API_KEY: mangled }),
    (e: Error) => {
      assert.match(e.message, /ANTHROPIC_API_KEY/);
      assert.match(e.message, /index 40/);
      assert.match(e.message, /U\+0425/);
      // It must say what to DO — re-copy the key, not debug the pipeline.
      assert.match(e.message, /console\.anthropic\.com/);
      return true;
    },
  );
});

test("surrounding whitespace is caught — the other way secrets arrive broken", () => {
  for (const value of [`${GOOD}\n`, ` ${GOOD}`, `${GOOD} `]) {
    assert.throws(
      () => assertCredentialIsHeaderSafe({ ANTHROPIC_API_KEY: value }),
      /whitespace/,
      `expected a whitespace complaint for ${JSON.stringify(value)}`,
    );
  }
});

test("the auth-token variable is held to the same standard", () => {
  assert.throws(
    () =>
      assertCredentialIsHeaderSafe({
        ANTHROPIC_AUTH_TOKEN: `${GOOD.slice(0, 10)}　${GOOD.slice(11)}`,
      }),
    /ANTHROPIC_AUTH_TOKEN/,
  );
});

test("the guard never echoes the credential it is complaining about", () => {
  const mangled = GOOD.slice(0, 40) + "Х" + GOOD.slice(41);
  try {
    assertCredentialIsHeaderSafe({ ANTHROPIC_API_KEY: mangled });
    assert.fail("expected a throw");
  } catch (e) {
    // CI logs are readable by anyone who can see the run; a diagnostic that
    // prints the secret to explain the secret is worse than the bug.
    assert.doesNotMatch((e as Error).message, /sk-ant/);
  }
});
