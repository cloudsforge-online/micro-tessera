/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this
 * file, and getting it wrong reproduces a defect the estate already has.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module
 * (`NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register`), which reads
 * `OTEL_*` from the environment itself. That is why no `OTEL_*` variable appears in `src/env.ts`:
 * the service does not read them, so under rule 9 it must not declare them.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { KILN_FIRE_KIND, registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { createPresenceHub } from './presence.ts'
import { createStudioClient } from './studioclient.ts'
import { createMarketClient } from './marketclient.ts'
import { createCommunityClient, wardCommunitySlug } from './communityclient.ts'
import { createLedgerClient, issueObjectToAuthor, walletOf } from './ledgerclient.ts'
import { activateListing } from './economy.ts'
import { bindWardCommunity } from './world.ts'
import type { Db } from './outbox.ts'
import { firingLeaseKey } from './kiln.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. The estate's boot failures are otherwise bare V8
//    stacks the collector drops, so the only symptom is a container that exits instantly.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', { version: env.version, schemaVersion: SCHEMA_VERSION, port: env.port })

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does **not** migrate. Failing here rather than serving is the point:
//    a replica of the new code answering requests against the old schema corrupts data quietly,
//    whereas a container that refuses to start is a deploy that visibly stops.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report. The service is `starting` from here until `markReady()`.
const lifecycle = new Lifecycle({
  // Must exceed one load-balancer probe interval, or the balancer is still sending traffic when
  // the process stops accepting it.
  drainDelayMs: 5_000,
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      // The probe deadline is enforced by the Lifecycle's AbortSignal, but a driver that ignored
      // the signal would hang `/readyz` for ever. Racing the signal is what turns "the database is
      // not answering" into a fail rather than a hung readiness endpoint.
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(
    // Soft. If identity is down this service still serves everything that does not need a fresh
    // key — and marking it hard means one identity blip removes every service in the estate from
    // its balancer at once, which is a cascade, not a safety measure.
    httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }),
  )

// 6. The presence hub: ONE `LISTEN` for the process. A connection per subscriber exhausts a pool
//    of ten at ten viewers, and this is a world where sixty people stand in one ward.
//
//    A failure here is soft, deliberately. Presence is the one part of the world that degrades
//    rather than breaks: without the hub, the map still renders, parcels still claim, objects
//    still fire, and only the live movement of other avatars is missing. Refusing to boot over it
//    would take the whole title down for a feature the player can walk around without.
const presence = await createPresenceHub(sql).catch((err: unknown) => {
  logger.error('presence hub unavailable; the world serves without live movement', { err })
  return undefined
})

// 7. The job runner, constructed before the routes so the Kiln route has something to enqueue
//    into, and started before `listen()` so a replica that is draining stops claiming before it
//    stops serving.
const queue = new JobQueue(sql as unknown as JobsSql, { owner: env.instanceId })

/**
 * The Kiln's upstream, if one is configured.
 *
 * Absent is a SUPPORTED mode — `env.ts` says so and the route answers 503 `kiln_unconfigured`
 * rather than 500. A world whose Kiln is cold is a world you can still walk around in, and the
 * alternative is a title that refuses to boot over one optional dependency.
 */
const studio =
  env.studioUrl && env.serviceCredential
    ? createStudioClient({
        baseUrl: env.studioUrl,
        // A service token expires in ten minutes, so the token is a FUNCTION rather than a value.
        // `@cloudsforge/auth`'s ServiceTokenProvider is the estate's answer to keeping one live;
        // until this service is granted a credential in the deploy, the credential IS the token.
        token: async () => env.serviceCredential ?? '',
      })
    : undefined

if (!studio) {
  logger.info('no Kiln upstream configured; firings will answer 503', {
    studioUrl: Boolean(env.studioUrl),
    credential: Boolean(env.serviceCredential),
  })
}

/**
 * The market seam, and the ledger it needs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BOTH, OR NEITHER.** Activating a listing does two things that must both be possible: it issues
 * the object into the creator's ledger balance, and it lists at market. Market's activation
 * reserves the item (`market/src/listings.ts`, `holdEscrow` with `kind: 'listing_item'`), so a
 * market configured without a ledger cannot activate anything — it would create a market draft,
 * fail at the reserve, and leave a dead draft behind on every attempt.
 *
 * So the seam is constructed only when BOTH upstreams and the credential are present, and the
 * route answers 503 otherwise. A half-configured seam that fails at step three is worse than an
 * absent one, because the absent one says so in the answer.
 *
 * Note the asymmetry with the tokens, which is deliberate and is the substance of this whole
 * feature: the LEDGER call uses this service's credential (issuing an object is the platform's
 * act), while both MARKET calls relay the seller's own bearer token, because market takes the
 * seller from the token and pays it. See `marketclient.ts`'s header.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const ledger =
  env.ledgerUrl && env.serviceCredential
    ? createLedgerClient({
        baseUrl: env.ledgerUrl,
        token: async () => env.serviceCredential ?? '',
      })
    : undefined

const market =
  env.marketUrl && ledger
    ? createMarketClient({ baseUrl: env.marketUrl })
    : undefined

if (!market) {
  logger.info('no market upstream configured; listings can be drafted but not activated', {
    marketUrl: Boolean(env.marketUrl),
    ledgerUrl: Boolean(env.ledgerUrl),
    credential: Boolean(env.serviceCredential),
  })
}

/**
 * Ward governance. `micro-community`, and nothing of it reimplemented here.
 *
 * No credential is held for this one, and that is not an omission: community's create route
 * refuses a service token outright and takes the owner from the caller's own, so the only token
 * that works is the founding operator's, relayed per request. There is nothing for this service to
 * hold.
 */
const community = env.communityUrl ? createCommunityClient({ baseUrl: env.communityUrl }) : undefined

if (!community) {
  logger.info('no community upstream configured; wards cannot be given a government', {
    communityUrl: Boolean(env.communityUrl),
  })
}

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier: new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer }),
  sql,
  ...(presence ? { presence } : {}),
  ...(market && ledger
    ? {
        market: {
          activate: (input) =>
            activateListing(
              sql as unknown as Db,
              {
                market,
                // The ledger call, bound here rather than imported by `economy.ts` — see the
                // comment on `ActivateDeps.issueObject` for the import cycle that would
                // otherwise crash this service at boot.
                issueObject: (issue) => issueObjectToAuthor(ledger, issue),
              },
              input,
            ),
        },
      }
    : {}),
  // The wallet strip. Bound whenever a LEDGER is configured, independently of market: a player's
  // balances are worth showing in a world that cannot yet sell anything.
  ...(ledger ? { wallet: (subject: string) => walletOf(ledger, subject) } : {}),
  ...(community
    ? {
        governance: {
          found: async ({ ward, founderToken, correlationId }) => {
            const created = await community.createCommunity({
              slug: wardCommunitySlug(ward.slug),
              name: ward.name,
              founderToken,
              // The WARD's id. Community dedupes the POST on it, so a retried founding creates
              // one community rather than a second one under a slug that is already taken.
              idempotencyKey: ward.id,
              correlationId,
            })
            return bindWardCommunity(sql as unknown as Db, ward.id, created.id)
          },
        },
      }
    : {}),
  kilnConfigured: Boolean(studio),
  enqueueFiring: async (objectId, subject) => {
    // `owner:<subject>` — the same lease key shape studio uses, so one player's firings serialise
    // consistently on both sides (§11.4).
    await queue.enqueue({
      kind: KILN_FIRE_KIND,
      key: firingLeaseKey(subject),
      payload: { objectId, subject },
      onConflict: 'keep',
    })
  },
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql,
  logger,
  signingSecret: env.outboxSigningSecret,
  ...(studio ? { studio } : {}),
})
await seedRecurring(queue)
runner.start()

// 8. Listen. Last of the construction steps, because a socket that accepts before its dependencies
//    exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 9. Ready. Only now: the state moves `starting → ready`, `/readyz` starts answering 200, and the
//    balancer is allowed to send traffic. Flipping this before `listen()` would advertise a
//    replica that has no socket.
lifecycle.markReady()

// 10. Signal handlers, last of all. Installing them earlier means a SIGTERM arriving mid-boot
//     drains a service that was never ready, and the drain races the construction above. Hooks run
//     in reverse registration order, so the server closes first, then the runner stops claiming
//     and drains, then the pool closes with nothing left to use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  await presence?.close().catch(() => {})
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget. Closing them is what
      // makes `server.close()` a bounded operation rather than a wait on the slowest client.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
