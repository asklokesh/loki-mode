import { expect, test } from "bun:test";
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

test("signup normalizes email and trims username", () => {
  expect(signup({ email: "  Ann+news@Example.COM ", username: " ann_1 ", password: "hunter22" })).toEqual({
    email: "ann+news@example.com",
    username: "ann_1",
  });
});

test("signup error messages", () => {
  expect(() => signup({ email: "  ", username: "ann", password: "hunter22" })).toThrow("email is required");
  expect(() => signup({ email: "ann@", username: "ann", password: "hunter22" })).toThrow("email is invalid");
  expect(() => signup({ email: "a@b.co", username: "ab", password: "hunter22" })).toThrow(
    "username must be 3 to 20 characters",
  );
  expect(() => signup({ email: "a@b.co", username: "9lives", password: "hunter22" })).toThrow(
    "username must not start with a digit",
  );
  expect(() => signup({ email: "a@b.co", username: "Ann", password: "hunter22" })).toThrow(
    "username may only contain a-z, 0-9 and _",
  );
  expect(() => signup({ email: "a@b.co", username: "ann", password: "short" })).toThrow(
    "password must be at least 8 characters",
  );
  expect(errorOf(() => signup({ email: "", username: "ann", password: "hunter22" })).name).toBe("ValidationError");
});

test("profile validates only the fields that change", () => {
  expect(updateProfile(base, { bio: "hi" })).toEqual({ ...base, bio: "hi" });
  expect(updateProfile(base, { email: " Bo@Example.org" }).email).toBe("bo@example.org");
  expect(updateProfile(base, { username: "  bo_b " }).username).toBe("bo_b");
  expect(() => updateProfile(base, { email: "nope" })).toThrow("email is invalid");
  expect(() => updateProfile(base, { username: "" })).toThrow("username is required");
  expect(() => updateProfile(base, { bio: "x".repeat(161) })).toThrow("bio must be at most 160 characters");
});

test("invites", () => {
  expect(createInvite(" ann ", "Bo+team@Example.com")).toEqual({ from: "ann", to: "bo+team@example.com" });
  expect(inviteMany("ann", ["a@x.io", "A@X.io ", "b@x.io"])).toEqual([
    { from: "ann", to: "a@x.io" },
    { from: "ann", to: "b@x.io" },
  ]);
  expect(() => inviteMany("ann", [])).toThrow("at least one email is required");
  expect(() => createInvite("1ann", "a@x.io")).toThrow("username must not start with a digit");
});
