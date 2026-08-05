/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 *
 * The subject here is `INBOUND_SIGNING_SECRET`, which is a LIST rather than a value. See the field
 * comment in `env.ts` for why: rotating one estate-wide key by swapping it partitions delivery for
 * the length of the rolling deploy, and the only way to avoid that is an overlap window in which
 * the receiver accepts both.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
const BASE: Record<string, string> = {
  TESSERA_DATABASE_URL: 'postgres://tessera:tessera@127.0.0.1:5432/tessera',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'a-real-looking-secret-of-sufficient-length',
  INBOUND_SIGNING_SECRET: 'another-real-looking-secret-of-length',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/** Obviously fake, both of them, and long enough to clear the length rule. Never real keys. */
const NEXT_KEY = 'rotation-fixture-next-key-not-a-real-secret'
const PRIOR_KEY = 'rotation-fixture-prior-key-not-a-real-secret'

const { EnvError, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  const env = loadEnv(BASE, 'host')
  assert.equal(env.databaseUrl, BASE['TESSERA_DATABASE_URL'])
})

test('a missing variable names itself', () => {
  const { IDENTITY_ISSUER: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), (err: unknown) => {
    assert.ok(err instanceof EnvError)
    assert.match(err.message, /IDENTITY_ISSUER/)
    return true
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * INBOUND_SIGNING_SECRET — the rotation window.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('a single INBOUND_SIGNING_SECRET is a list of one, so nothing about today changes', () => {
  assert.deepEqual(
    [...loadEnv(BASE, 'host').inboundSigningSecrets],
    [BASE['INBOUND_SIGNING_SECRET']],
  )
})

test('INBOUND_SIGNING_SECRET is a comma-separated list, newest first, and signing stays single', () => {
  const env = loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: ` ${NEXT_KEY} , ${PRIOR_KEY} ` }, 'host')
  assert.deepEqual([...env.inboundSigningSecrets], [NEXT_KEY, PRIOR_KEY])
  // Signing is NOT a list. Two outbound signatures would double every subscriber's verification
  // work and leave nobody able to say which key an event was signed with.
  assert.equal(env.outboxSigningSecret, BASE['OUTBOX_SIGNING_SECRET'])
})

test('every INBOUND_SIGNING_SECRET entry is held to the same bar as a single one was', () => {
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},changeme` }, 'host'),
    /placeholder/,
  )
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},short` }, 'host'),
    /at least 24/,
  )
  // A list of separators is an empty list, which would accept nothing and 401 every producer.
  assert.throws(() => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: ' , , ' }, 'host'), /at least one/)
  // And absent is still absent, rather than an empty list that boots.
  const { INBOUND_SIGNING_SECRET: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), /INBOUND_SIGNING_SECRET/)
})

test('INBOUND_SIGNING_SECRET listing the same secret twice is refused', () => {
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows the rotation has finished and the old key can be dropped.
  assert.throws(
    () => loadEnv({ ...BASE, INBOUND_SIGNING_SECRET: `${NEXT_KEY},${NEXT_KEY}` }, 'host'),
    /twice/,
  )
})
