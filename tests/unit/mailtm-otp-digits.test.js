// Phase 02 (X10): OTP extraction is digits-only — 6-letter English words in
// subjects/bodies ("Verify") must never be submitted as the code.
import { describe, expect, it } from "vitest";
import { extractVerificationCode } from "../../src/lib/totuAutoFetch/mailtm.js";

describe("extractVerificationCode (X10)", () => {
  it("extracts a 6-digit code from text", () => {
    expect(extractVerificationCode({ subject: "", text: "Your verification code is 482913", html: "" })).toBe("482913");
  });

  it("extracts from the subject when present", () => {
    expect(extractVerificationCode({ subject: "Code: 135790", text: "", html: "" })).toBe("135790");
  });

  it("rejects 6-letter words like Verify (the old regex matched these)", () => {
    expect(extractVerificationCode({ subject: "Verify your email", text: "", html: "" })).toBeNull();
    expect(extractVerificationCode({ subject: "", text: "Please Verify your account", html: "" })).toBeNull();
  });

  it("rejects alphanumeric codes and prefers digits when both exist", () => {
    expect(extractVerificationCode({ subject: "8e1b0c", text: "", html: "" })).toBeNull();
    expect(extractVerificationCode({ subject: "Verify", text: "code 778899", html: "" })).toBe("778899");
  });

  it("strips HTML tags before matching", () => {
    expect(extractVerificationCode({ subject: "", text: "", html: "<p>code: <b>112233</b></p>" })).toBe("112233");
  });

  it("returns null for empty/absent messages", () => {
    expect(extractVerificationCode(null)).toBeNull();
    expect(extractVerificationCode({ subject: "", text: "", html: "" })).toBeNull();
  });
});
