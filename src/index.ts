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
import { assertSchemaAtLeast, networkSql, type Sql as DbSql, type Sql as RuntimeSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { env } from './env.ts'
import { SERVICE } from './service.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { KILN_FIRE_KIND, registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { createPresenceHub } from './presence.ts'
import { buildUpstreams } from './upstreams.ts'
import { wardCommunitySlug } from './communityclient.ts'
import { issueObjectToAuthor, walletOf } from './ledgerclient.ts'
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
const poolOptions = {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
}
const sql = postgres(env.databaseUrl, poolOptions)

// ── ONE HANDLE PER NETWORK THIS DEPLOYMENT SERVES ────────────────────────────────────────────
//
// `TESSERA_DATABASE_URL_TESTNET` unset is the single-network case, which is every deployment until the
// consolidation reaches this service. `networkSql` then holds one handle and REFUSES a testnet
// request rather than answering it out of mainnet rows — substituting would be a query that
// SUCCEEDS against the other estate and says nothing.
const sqlTestnet = env.databaseUrlTestnet ? postgres(env.databaseUrlTestnet, poolOptions) : undefined

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

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 7a. The upstreams, and the credential presented to two of the four.
//
// The BODY of this used to be here — `token: async () => env.serviceCredential ?? ''`, handed to
// studio at :134 and to the ledger at :172 — and that is micro-org #222: a 600-second token
// (`identity/src/tokens.ts`) read once at import and never renewed, measured expired for
// twenty-six hours on a container whose `/livez` answered 200 throughout.
//
// It moved to `src/upstreams.ts` for one reason: wiring in a composition root is wiring no test can
// reach. This file opens a pool, asserts a schema, opens a LISTEN connection and calls `listen()`,
// so a test that imported it would start a server — which is why ninety-odd green tests could not
// see a service that authenticated once and died. That file carries the whole argument, including
// why market and community deliberately hold no credential and why no readiness probe is wired.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const upstreams = buildUpstreams(env, {
  // So a world object generated off the world's brief is a line somebody can find, rather than a
  // chair that quietly does not match the ward it stands in.
  studioLogger: logger.child({ upstream: 'studio' }),
  onEvent: (event) => {
    metrics.increment('tessera_service_token_events_total', { kind: event.kind })
    if (event.kind === 'minted') {
      // The token itself is never a field here, and must never become one. `service`, `expiresIn`
      // and the refresh interval are what an operator needs; the bearer is what an attacker needs.
      logger.info('minted a service token from the credential', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else if (event.kind === 'exchange_failed') {
      // `warn`, not `fatal`, and only because of `hadUsableToken`: a failed exchange while a live
      // token is still held is exactly the outage the provider is built to ride out, and paging on
      // it would page on every identity blip.
      logger.warn('service credential exchange failed', { ...event })
    }
  },
})
const { studio, ledger, market, community } = upstreams

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Said at boot, at the level its consequence deserves, because the alternative is what actually
// happened: a world that looks entirely healthy while its Kiln cannot fire and its treasury cannot
// pay. `static` is FATAL and `none` is not, and the difference is the point — "no upstream is
// configured" is a mode this service promises to support, while "an upstream is configured and the
// credential cannot renew" is a container that will start refusing about ten minutes from now.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const credentialedUpstream = Boolean(env.studioUrl ?? env.ledgerUrl)
if (upstreams.mode === 'static') {
  logger.fatal('EXPIRING TOKEN, NOT A CREDENTIAL — every Kiln firing and every EMBER grant will 401 about ten minutes from now', {
    whatWillHappen:
      'TESSERA_SERVICE_CREDENTIAL holds a token that lives 600s and nothing can renew it. From ' +
      'minute ten studio refuses every firing, so a paid Kiln job dies in the runner and retries ' +
      'into the same 401; the ledger refuses every engagement grant, every booking reservation and ' +
      'every release, so a Venue hold is taken and cannot be returned. /livez keeps answering 200 ' +
      'throughout, because it presents the credential to nobody.',
    remedy:
      'set TESSERA_IDENTITY_CREDENTIAL in the deploy; deploy/compose/estate/tokens.env already holds one',
  })
} else if (upstreams.mode === 'none' && credentialedUpstream) {
  logger.fatal('AN UPSTREAM IS CONFIGURED AND NO CREDENTIAL IS — every call to it will answer 503', {
    studioUrl: Boolean(env.studioUrl),
    ledgerUrl: Boolean(env.ledgerUrl),
    remedy: 'set TESSERA_IDENTITY_CREDENTIAL (long-lived, cfsc_…, from POST /service-credentials)',
  })
} else {
  logger.info('service credential mode', {
    mode: upstreams.mode,
    identityUrl: env.identityUrl,
  })
}

// The informational lines below are unchanged in substance: absent is a SUPPORTED mode. `env.ts`
// says so and `.env.example` promises it — the Kiln answers 503 `kiln_unconfigured` and the world
// still serves. A title that refused to boot over one optional dependency would be worse.
if (!studio) {
  logger.info('no Kiln upstream configured; firings will answer 503', {
    studioUrl: Boolean(env.studioUrl),
    credentialMode: upstreams.mode,
  })
}

if (!market) {
  // BOTH, OR NEITHER — see `upstreams.ts`. Market's activation reserves the item in the ledger, so
  // a market configured without a ledger creates a dead draft on every attempt.
  logger.info('no market upstream configured; listings can be drafted but not activated', {
    marketUrl: Boolean(env.marketUrl),
    ledgerUrl: Boolean(env.ledgerUrl),
    credentialMode: upstreams.mode,
  })
}

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
  // The SELECTOR, not a handle — routes use `ctx.sql`, resolved once per request.
  sql: networkSql({
    mainnet: sql as unknown as RuntimeSql,
    ...(sqlTestnet ? { testnet: sqlTestnet as unknown as RuntimeSql } : {}),
  }),
  ...(env.singleNetwork ? { singleNetwork: env.singleNetwork as 'mainnet' | 'testnet' } : {}),
  // The receiving half of the estate's event signing. The SAME list `env.ts` documents at length
  // — one variable, parsed to a list so a rotation has an overlap window — and not a second
  // secret invented for this route.
  eventAcceptSecrets: env.inboundSigningSecrets,
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
  // The Venue calendar's escrow, bound on the same condition and for the same reason the wallet
  // is: booking has nothing to do with micro-market. The client IS the seam — reserve, release
  // and the fee are three of its methods, and there is no adapter here because there is nothing
  // for one to adapt. Without a ledger the three booking routes answer 503, which is the honest
  // answer for a hold nobody can take.
  ...(ledger ? { escrow: ledger } : {}),
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
    // Read out of the provider's own memory — no outbound call, so a scrape cannot become load on
    // identity. See `registerServiceMetrics` for why `static` reads as usable and why the second
    // gauge is what stops that being a lie.
    metrics.set(
      'tessera_service_token_usable',
      upstreams.mode === 'exchanged'
        ? (upstreams.identityTokens?.snapshot().hasUsableToken ?? false)
          ? 1
          : 0
        : upstreams.mode === 'static'
          ? 1
          : 0,
    )
    metrics.set('tessera_service_token_static', upstreams.mode === 'static' ? 1 : 0)
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
