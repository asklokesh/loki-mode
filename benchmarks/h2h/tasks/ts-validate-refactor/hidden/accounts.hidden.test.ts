import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ValidationError, validateEmail, validateUsername } from "../src/validate";
import { signup } from "../src/signup";
import { updateProfile } from "../src/profile";
import { createInvite, inviteMany } from "../src/invite";

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

const base = { email: "ann@example.com", username: "ann", bio: "" };
const longEmail = "a".repeat(250) + "@x.io";

test("validateEmail normalizes and returns the email", () => {
  expect(validateEmail("  Ann+News@Example.COM ")).toBe("ann+news@example.com");
  expect(validateEmail("first.last%x@sub.example.co.uk")).toBe("first.last%x@sub.example.co.uk");
});

test("validateEmail messages in order", () => {
  expect(() => validateEmail("   ")).toThrow("email is required");
  expect(() => validateEmail(longEmail)).toThrow("email is too long");
  expect(() => validateEmail("ann@example")).toThrow("email is invalid");
  expect(() => validateEmail("ann example@x.io")).toThrow("email is invalid");
  expect(errorOf(() => validateEmail("nope"))).toBeInstanceOf(ValidationError);
  expect(errorOf(() => validateEmail("nope")).name).toBe("ValidationError");
});

test("validateUsername rules and messages in order", () => {
  expect(validateUsername("  ann_99 ")).toBe("ann_99");
  expect(validateUsername("a".repeat(20))).toBe("a".repeat(20));
  expect(() => validateUsername(" ")).toThrow("username is required");
  expect(() => validateUsername("a".repeat(21))).toThrow("username must be 3 to 20 characters");
  expect(() => validateUsername("9")).toThrow("username must be 3 to 20 characters");
  expect(() => validateUsername("1AB")).toThrow("username must not start with a digit");
  expect(() => validateUsername("Ann")).toThrow("username may only contain a-z, 0-9 and _");
  expect(() => validateUsername("an-n")).toThrow("username may only contain a-z, 0-9 and _");
  expect(errorOf(() => validateUsername(""))).toBeInstanceOf(ValidationError);
});

test("signup behaviour is unchanged", () => {
  expect(signup({ email: " Ann+news@Example.COM", username: " ann_1 ", password: "hunter22" })).toEqual({
    email: "ann+news@example.com",
    username: "ann_1",
  });
  expect(() => signup({ email: longEmail, username: "ann", password: "hunter22" })).toThrow("email is too long");
  expect(() => signup({ email: "bad", username: "x", password: "x" })).toThrow("email is invalid");
  expect(() => signup({ email: "a@b.co", username: "Ann", password: "hunter22" })).toThrow(
    "username may only contain a-z, 0-9 and _",
  );
  const pw = errorOf(() => signup({ email: "a@b.co", username: "ann", password: "short" }));
  expect(pw.message).toBe("password must be at least 8 characters");
  expect(pw).toBeInstanceOf(ValidationError);
  expect(errorOf(() => signup({ email: "", username: "ann", password: "hunter22" }))).toBeInstanceOf(ValidationError);
});

test("profile behaviour is unchanged", () => {
  expect(updateProfile(base, {})).toEqual(base);
  expect(updateProfile(base, { email: " Bo+x@Example.org", username: " bo_b " })).toEqual({
    email: "bo+x@example.org",
    username: "bo_b",
    bio: "",
  });
  expect(() => updateProfile(base, { email: "" })).toThrow("email is required");
  expect(() => updateProfile(base, { username: "7up" })).toThrow("username must not start with a digit");
  expect(() => updateProfile(base, { username: "a".repeat(21) })).toThrow("username must be 3 to 20 characters");
  const bio = errorOf(() => updateProfile(base, { bio: "x".repeat(161) }));
  expect(bio.message).toBe("bio must be at most 160 characters");
  expect(bio).toBeInstanceOf(ValidationError);
  expect(errorOf(() => updateProfile(base, { email: "x" }))).toBeInstanceOf(ValidationError);
});

test("invite behaviour is unchanged", () => {
  expect(createInvite("ann", " Bo+Team@Example.com ")).toEqual({ from: "ann", to: "bo+team@example.com" });
  expect(inviteMany(" ann ", ["c@x.io", "C@x.io", "a@x.io"])).toEqual([
    { from: "ann", to: "c@x.io" },
    { from: "ann", to: "a@x.io" },
  ]);
  expect(() => createInvite("ann", "a@x")).toThrow("email is invalid");
  expect(() => createInvite("An", "a@x.io")).toThrow("username must be 3 to 20 characters");
  expect(() => inviteMany("ann", ["a@x.io", "bad"])).toThrow("email is invalid");
  const none = errorOf(() => inviteMany("ann", []));
  expect(none.message).toBe("at least one email is required");
  expect(none).toBeInstanceOf(ValidationError);
  expect(errorOf(() => createInvite("1ann", "a@x.io"))).toBeInstanceOf(ValidationError);
});

test("the three modules use validate.ts instead of their own copies", () => {
  for (const file of ["signup.ts", "profile.ts", "invite.ts"]) {
    const text = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
    expect(text).toMatch(/from\s+["']\.\/validate(\.ts)?["']/);
    expect(text).not.toContain("email is invalid");
    expect(text).not.toContain("username must be 3 to 20 characters");
    expect(text).not.toContain("username must not start with a digit");
    expect(text).not.toMatch(/class\s+ValidationError/);
    expect(text).not.toContain("@[");
  }
});
