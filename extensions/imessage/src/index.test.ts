import { describe, expect, it } from "bun:test";
import { isAllowedSender } from "./index";

describe("isAllowedSender", () => {
  it("allows exact email matches", () => {
    expect(isAllowedSender("claudia@iamclaudia.ai", ["claudia@iamclaudia.ai"])).toBe(true);
  });

  it("allows exact phone matches", () => {
    expect(isAllowedSender("4155551212", ["4155551212"])).toBe(true);
  });

  it("normalizes phone numbers when both sides are phones", () => {
    expect(isAllowedSender("415-555-1212", ["+1 (415) 555-1212"])).toBe(true);
  });

  it("does not match different emails (critical bug case)", () => {
    expect(isAllowedSender("claudia@iamclaudia.ai", ["turbotax_hbjdkwfr_agent@rbm.goog"])).toBe(
      false,
    );
  });

  it("does not match mixed email/phone values", () => {
    expect(isAllowedSender("claudia@iamclaudia.ai", ["+1 415 555 1212"])).toBe(false);
    expect(isAllowedSender("4155551212", ["claudia@iamclaudia.ai"])).toBe(false);
  });

  it("handles empty and malformed inputs safely", () => {
    expect(isAllowedSender("", ["+1 415 555 1212"])).toBe(false);
    expect(isAllowedSender("----", ["(415) 555-1212"])).toBe(false);
    expect(isAllowedSender("4155551212", [""])).toBe(false);
  });

  it("treats RBM addresses as emails and requires exact match", () => {
    expect(
      isAllowedSender("turbotax_hbjdkwfr_agent@rbm.goog", ["turbotax_hbjdkwfr_agent@rbm.goog"]),
    ).toBe(true);
    expect(isAllowedSender("turbotax_hbjdkwfr_agent@rbm.goog", ["other@rbm.goog"])).toBe(false);
  });
});
