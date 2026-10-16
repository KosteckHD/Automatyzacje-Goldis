"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { checkFeatureBoundaries } = require("./check-feature-boundaries.cjs");

test("feature boundaries reject cross-feature private imports and cycles", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-feature-boundaries-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("features/auth/auth.module.ts", 'import { UserRepository } from "../users/users.repository";\n');
  write("features/auth/auth.service.ts", "export class AuthService {}\n");
  write("features/users/users.repository.ts", 'import { AuthService } from "../auth/auth.service";\n');
  const result = checkFeatureBoundaries(directory);
  assert.equal(result.violations.length, 2);
  assert.equal(result.cycles.length, 1);
});

test("feature boundaries accept public entries and same-feature imports", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goldis-feature-boundaries-public-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, content) => {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("features/auth/auth.service.ts", 'import { UserRepository } from "../users";\nimport { SessionStore } from "./session.store";\n');
  write("features/users/index.ts", 'export { UserRepository } from "./users.repository";\n');
  write("features/users/users.repository.ts", "export class UserRepository {}\n");
  write("features/auth/session.store.ts", "export class SessionStore {}\n");
  const result = checkFeatureBoundaries(directory);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.cycles, []);
});
