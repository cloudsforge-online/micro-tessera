/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable the service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody, which is the only service in the old
 * estate that gets this right:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic: everything derived from it is forgeable by anyone who can read the
 *      repository, and a placeholder that boots is a placeholder that reaches production.
 */

import { hostname } from 'node:os'

/**
 * The service's own name, from `service.ts` and NOT re-exported from here.
 *
 * This module exits the process when a variable is missing, at import, on purpose. So anything
 * that wants only the service's name must not have to import this file to get it — four modules
 * did, and it took eleven test files down with them. `service.ts` has the whole account.
 */
import { SERVICE } from './service.ts'

/**
 * The port this service binds, stated once.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **4022, AND THE NUMBER IS ARGUED RATHER THAN PICKED.** 23-tessera.md §10.1 separates three
 * port spaces this estate keeps confusing:
 *
 *   1. the port a service BINDS in its container — this value;
 *   2. the HOST port in the estate compose file, which is DERIVED (`4100 + index in
 *      deployableRepos()`, `org/tools/cfctl.ts:864-871`) and therefore never chosen;
 *   3. the `devPort` in micro-ui's surface registry, documented as "not an allocation; it is a
 *      fact about a service" (`ui/packages/ui/src/surfaces.ts:455`).
 *
 * Spaces (1) and (2) already collide three times: emberkin binds 4100, which is identity's
 * compose host port; aetherholm binds 4120, which is admin-api's; nda binds 4110, which is
 * notify's. Each of those is a service whose own bind address is a number the estate hands to
 * somebody else.
 *
 * 4022 is BELOW the derived 4100+ block, so no number of repositories appended to
 * `deployableRepos()` can ever grow into it. That is the whole reason for the choice: not that
 * 4022 is free today — 4100 was free the day emberkin took it — but that it is in a region the
 * derivation cannot reach.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const DEFAULT_PORT = 4022

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * Values that must never be accepted. The list is short on purpose: it holds the strings that
 * actually appear in this repository's own `.env.example` and compose files, because those are
 * the ones that get copied into a deployment by someone in a hurry.
 */
const PLACEHOLDERS = new Set([
  'changeme',
  'change_me',
  'change-me',
  'placeholder',
  'secret',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

/**
 * A comma-separated list of secrets, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does, and that instant does not exist during a rolling
 * deploy. The receiver publishes the new key, accepts both for a window, then drops the old one.
 *
 * Every entry is held to exactly the bar a single secret was held to — a rotation is not an excuse
 * to smuggle a placeholder in beside a real key. The house pattern; `devplatform/src/env.ts:103`
 * is the reference implementation and `activity` and `notify` carry the same shape.
 */
function parseSecretList(raw: string, name: string, minLength = 24): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  for (const entry of entries) {
    if (PLACEHOLDERS.has(entry.toLowerCase())) {
      throw new EnvError(`${name} contains a known placeholder — generate real secrets`)
    }
    if (entry.length < minLength) {
      throw new EnvError(`${name} entries must each be at least ${minLength} characters`)
    }
  }
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes the "which key verified this" answer ambiguous, and that answer is
    // what tells an operator whether a rotation has finished and the old key may be dropped.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

function requiredSecretList(source: Source, name: string, minLength = 24): readonly string[] {
  return parseSecretList(required(source, name), name, minLength)
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function optionalOrigin(source: Source, name: string): string | undefined {
  const raw = source[name]?.trim()
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new EnvError(`${name} must be an absolute URL (got ${raw})`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EnvError(`${name} must be http or https (got ${url.protocol})`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new EnvError(`${name} must be an origin with no path, query or fragment (got ${raw})`)
  }
  return url.origin
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /** HMAC key for outbound event signatures, so a subscriber can prove an event came from us. */
  readonly outboxSigningSecret: string
  /**
   * The same secret, on the way in — and a LIST of them, newest first.
   *
   * Deliveries this service RECEIVES — `market.listing.sold`, `community.proposal.executed`,
   * `billing.entitlement.granted` — are signed by the producer with the estate outbox secret, and
   * `src/inbound.ts` verifies over the raw bytes before parsing them. It is a separate variable
   * from `OUTBOX_SIGNING_SECRET` even though the deploy sets both to the same value today, because
   * the day the estate moves to per-producer signing secrets (which `contracts-auth`'s
   * `admin:audit:write` entry argues for) the two stop being the same value and a service that
   * read one variable for both would have to be found.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **A LIST, AND STILL ONE VARIABLE.** The estate's outbox secret is a single key shared by 24
   * services. Rotating it by swapping the value means a producer that moves first has every
   * delivery refused here until this service restarts too — the deliveries do not error loudly,
   * they PARTITION, and the failure reads as a secret mismatch rather than as a deploy ordering
   * problem. So the receiver accepts every key that may have signed an inbound delivery, the
   * operator adds the new one, moves the producers, and then removes the old one.
   *
   * A second variable was not added: the existing name becoming a list is the smaller change and
   * it matches `notify`, whose `NOTIFY_INGEST_SIGNING_SECRET` is also singular-named and also
   * parses to a list. `SIGNING` stays a single value — see `outboxSigningSecret` above — because
   * signing with two keys at once would double every subscriber's verification work and leave
   * nobody able to say which key an event was signed with.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly inboundSigningSecrets: readonly string[]
  /**
   * Names this replica in `jobs.locked_by`. Defaults to the hostname, which is the container id
   * under compose and the pod name under Kubernetes — in both cases the thing an operator would
   * search for after finding a stuck lease.
   */
  readonly instanceId: string
  /**
   * `micro-studio`'s origin, for the Kiln. **Optional, and its absence is a supported mode**:
   * without it `POST /v1/kiln/firings` answers 503 `kiln_unconfigured` rather than 500, and every
   * other route in the service works. A world whose Kiln is down is a world you can still walk
   * around in, and the alternative — refusing to boot — takes the whole title out over one
   * upstream.
   */
  readonly studioUrl: string | undefined
  /** `micro-ledger`'s origin. Same optionality, same reason: reads still serve without it. */
  readonly ledgerUrl: string | undefined
  /** `micro-market`'s origin, for listings. Same optionality. */
  readonly marketUrl: string | undefined
  /**
   * `micro-community`'s origin, for ward governance. Same optionality.
   *
   * **No credential accompanies it, and that is deliberate rather than missing.** Community's
   * `POST /v1/communities` refuses a service token — "accepting one would make every service in
   * the estate a voting member of every community" — and takes the owner from the caller's own
   * token. So the only credential that works is the founding operator's, relayed per request, and
   * there is nothing for this service to hold or rotate.
   */
  readonly communityUrl: string | undefined
  /**
   * The credential this service exchanges for a service token when it calls studio, ledger or
   * market. Optional for the same reason the three URLs are; `requiredSecret` when present, so a
   * placeholder credential cannot boot.
   */
  readonly serviceCredential: string | undefined
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

/**
 * Pure over its source so the failure paths are testable without mutating the process. The eager
 * export below is what makes the service fail fast.
 */
export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }
  const credential = source['TESSERA_SERVICE_CREDENTIAL']?.trim()
  return {
    port: integer(source, 'PORT', DEFAULT_PORT, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'TESSERA_DATABASE_URL'),
    // A pool larger than the database's own connection budget divided by the replica count is a
    // service that exhausts Postgres for everything else the moment it scales.
    databasePoolMax: integer(source, 'TESSERA_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    inboundSigningSecrets: requiredSecretList(source, 'INBOUND_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
    studioUrl: optionalOrigin(source, 'STUDIO_URL'),
    ledgerUrl: optionalOrigin(source, 'LEDGER_URL'),
    marketUrl: optionalOrigin(source, 'MARKET_URL'),
    communityUrl: optionalOrigin(source, 'COMMUNITY_URL'),
    serviceCredential: credential ? requiredSecret(source, 'TESSERA_SERVICE_CREDENTIAL') : undefined,
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed
 * through the telemetry package: nothing that can itself fail may sit between a configuration
 * error and the report of it. The message is the one `loadEnv` produced, which by construction
 * never contains a value.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
