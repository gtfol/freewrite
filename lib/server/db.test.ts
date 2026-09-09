import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "pg";
import { databasePoolConfig } from "./db.ts";

const REMOTE = "postgresql://postgres.project:password@aws-0-us-west-2.pooler.supabase.com:6543/postgres";
const CA = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";

// Check the settings pg actually consumes: passing connectionString alongside
// ssl lets its URL parser silently replace the certificate and verification.
test("remote database clients require verified TLS", () => {
  const client = new Client(databasePoolConfig(REMOTE));
  assert.deepEqual(client.ssl, { rejectUnauthorized: true });
});

test("database clients receive the configured CA with normal or escaped newlines", () => {
  for (const certificate of [CA, `  ${CA.replaceAll("\n", "\\n")}  `]) {
    const client = new Client(databasePoolConfig(REMOTE, certificate));
    assert.deepEqual(client.ssl, { rejectUnauthorized: true, ca: CA });
  }
});

test("connection URL SSL options cannot override verified TLS or its CA", () => {
  for (const query of [
    "sslmode=disable",
    "sslmode=no-verify",
    "ssl=0",
    "ssl=no-verify",
    "sslmode=require",
    "sslmode=require&uselibpqcompat=true",
    "sslmode=verify-ca&sslrootcert=/nonexistent/other-ca.crt",
  ]) {
    const client = new Client(databasePoolConfig(`${REMOTE}?${query}`, CA));
    assert.deepEqual(client.ssl, { rejectUnauthorized: true, ca: CA }, query);
  }
});

test("only exact loopback hosts disable TLS for local development", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const client = new Client(databasePoolConfig(`postgres://user:password@${host}/freewrite`));
    assert.equal(client.ssl, false, host);
  }
  for (const url of [
    "postgres://user:password@localhost.example.com/freewrite",
    "postgres://localhost:password@db.example.com/freewrite",
    "postgres://user:localhost@db.example.com/freewrite",
    "postgres://user:password@db.example.com/127.0.0.1",
    `${REMOTE}?host=localhost`,
  ]) {
    assert.deepEqual(new Client(databasePoolConfig(url)).ssl, { rejectUnauthorized: true }, url);
  }
});

test("URL query parameters cannot redirect a local connection to a remote host", () => {
  const config = databasePoolConfig("postgres://user:password@localhost/freewrite?host=db.example.com");
  assert.equal(new Client(config).host, "localhost");
  assert.equal(config.connectionString, undefined);
});

test("URL credentials, database name, and pooler port are preserved", () => {
  const config = databasePoolConfig(
    "postgres://postgres.project:p%40ss%2Fword%25@db.example.com:6543/free%20write",
    undefined,
    "8"
  );
  assert.equal(config.user, "postgres.project");
  assert.equal(config.password, "p@ss/word%");
  assert.equal(config.database, "free write");
  assert.equal(config.port, 6543);
  assert.equal(config.max, 8);
});

test("invalid connection URLs fail without exposing credentials", () => {
  for (const url of [
    "not a URL: private-password",
    "https://user:private-password@db.example.com/postgres",
    "postgres://user:private-password%ZZ@db.example.com/postgres",
  ]) {
    assert.throws(() => databasePoolConfig(url), {
      message: "DATABASE_URL must be a valid Postgres connection URL.",
    });
  }
});
