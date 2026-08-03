/**
 * The HTTP surface.
 *
 * Plain `node:http`, as the template and aetherholm both are. Rule 4 of docs/ecosystem/03 §2:
 * `/livez`, `/readyz` and `/metrics` on every service, or it does not pass CI.
 *
 * The one decision here that is easy to get backwards is the auth-fault mapping. A bad token is
 * 401. A verifier that could not reach the JWKS is **503**, never 401 — answering 401 there signs
 * every user in the estate out because the identity service is having a bad minute. `statusFor`
 * from `@cloudsforge/auth` is the one place that decides it, so five services cannot disagree.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * EVERY GATE IN THIS FILE DEMANDS A SCOPE THE ESTATE'S DERIVATION CAN READ.
 *
 * `requireScope(principal, LITERAL_CONSTANT)` — the shape `service-ci.yml`'s scope audit resolves
 * (`addGate('requireScope', 1)`, and `resolveExpr` follows a sibling constant to its literal). A
 * gate it cannot resolve is FATAL to the build, deliberately: a demand it cannot read is a demand
 * it cannot prove is registered, and identity fail-fasts at import on a grant naming an unknown
 * scope (`identity/src/env.ts:141`).
 *
 * Verified by running the estate's own extracted audit against this repository, not by reading the
 * workflow: it reports `tessera:provision`, `tessera:read` and `tessera:write`, each naming the
 * line below that demands it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import {
  PROVISION_PATH,
  TITLE_DESCRIPTOR_PATH,
  parseProvisionRequest,
  serialiseProvisionResult,
  serialiseTitleDescriptor,
} from '@cloudsforge/contracts-worlds'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import { PROVISION_SCOPE, READ_SCOPE, WRITE_SCOPE } from './scopes.ts'
import type { Db } from './outbox.ts'
import {
  bankParcel,
  claimParcel,
  findParcel,
  findWard,
  isTier,
  listFallow,
  listParcelsIn,
  listParcelsOf,
  listWards,
  openContest,
  setParcelFlags,
  WorldError,
} from './world.ts'
import {
  FACINGS,
  findObject,
  isCategory,
  listObjectsOf,
  listPlacements,
  placeObjects,
  removePlacement,
  requestFiring,
  type Facing,
  type Footprint,
} from './kiln.ts'
import { draftListing, findListing, listListingsOf, platformTerms } from './economy.ts'
import { lightBeacon, rankParcels, recordVisit } from './discovery.ts'
import { arrive, depart, whoIsIn, type PresenceHub } from './presence.ts'
import { TITLE_DESCRIPTOR, provision } from './titlecontract.ts'
import { parsePriceWei, toSparks } from './sparks.ts'

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly presence?: PresenceHub
  /** True when a Kiln upstream is configured. Absent is a supported mode — see `env.ts`. */
  readonly kilnConfigured?: boolean
  readonly enqueueFiring?: (objectId: string, subject: string) => Promise<void>
  /**
   * Refresh sampled gauges immediately before `/metrics` renders. Queue depth is a value that
   * must be read, not counted, and reading it on a timer would be the one `setInterval` in this
   * repository — the shape rule 8 exists to keep out. A scrape is already periodic.
   */
  readonly beforeScrape?: () => Promise<void>
}

export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'tessera_parcels_claimed_total',
      help: 'Parcels claimed',
      kind: 'counter',
      labels: ['tier'],
    })
    .register({
      name: 'tessera_firings_total',
      help: 'Kiln firings requested',
      kind: 'counter',
      labels: ['footprint'],
    })
    .register({
      name: 'tessera_provisions_total',
      help: 'Title provisions',
      kind: 'counter',
      labels: ['outcome'],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 256 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly stream?: (res: ServerResponse) => void
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  readonly path: string
  readonly pattern: RegExp
  readonly names: readonly string[]
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

function compile(path: string): { pattern: RegExp; names: string[] } {
  const names: string[] = []
  const source = path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      names.push(segment.slice(1))
      return '([^/]+)'
    })
    .join('/')
  return { pattern: new RegExp(`^${source}$`), names }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    // Echoed before anything can fail, so even a 500 carries the id the user will quote.
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== (req.method ?? 'GET')) continue
      const m = route.pattern.exec(url.pathname)
      if (!m) continue
      matched = route
      params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(m[i + 1] ?? '')]))
      break
    }
    // Unmatched paths collapse to one label. Using the raw path would let any caller mint
    // unbounded time series and take the scrape target down with cardinality.
    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method: req.method ?? 'GET', route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', {
        method: req.method ?? 'GET',
        route: routeLabel,
        status: String(status),
      })
      deps.metrics.observe('http_request_duration_ms', durationMs, {
        method: req.method ?? 'GET',
        route: routeLabel,
      })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        if (reply.stream) {
          finish(reply.status)
          reply.stream(res)
          return
        }
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(
  route: Route | undefined,
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof WorldError) {
      return errorReply(err.status, err.code, err.message, ctx.requestId)
    }
    if (err instanceof BadRequestError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => {
    const { pattern, names } = compile(path)
    return { method, path, pattern, names, handle: handler }
  }

  return [
    /* ------------------------------------------------------------------------- operational */

    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* --------------------------------------------------------------- the title contract */

    // Public and unauthenticated: a descriptor is a capability statement, and worlds reads it
    // before it holds any credential for this title. Both paths come from the contract, so this
    // service cannot serve a route worlds does not call.
    define('GET', TITLE_DESCRIPTOR_PATH, async () => ({
      status: 200,
      body: serialiseTitleDescriptor(TITLE_DESCRIPTOR),
    })),

    define('POST', PROVISION_PATH, async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind !== 'service') {
        // Provisioning is the platform's act, driven by a paid entitlement. A user token here is
        // somebody trying to raise a ward without buying one.
        throw new ForbiddenError(PROVISION_SCOPE)
      }
      requireScope(principal, PROVISION_SCOPE)

      // Parsed by the CONTRACT's parser, not by six hand-written `requireString` calls. The
      // correlation id is passed in rather than read from the body because it travels as the
      // request id header and is deliberately not a wire field — a receiver that made it a
      // required body field would 400 every real request from the bridge and pass every test
      // written from the interface.
      const parsed = parseProvisionRequest(await readJson(ctx.req), ctx.requestId)
      if (!parsed.ok) throw new BadRequestError(parsed.errors.join('; '))

      const done = deps.lifecycle.track()
      try {
        const outcome = await provision(deps.sql, parsed.value)
        deps.metrics.increment('tessera_provisions_total', {
          outcome: outcome.replayed ? 'replayed' : 'provisioned',
        })
        ctx.log.info('provisioned', {
          entitlementId: parsed.value.entitlementId,
          urn: outcome.urn,
          replayed: outcome.replayed,
        })
        return { status: outcome.replayed ? 200 : 201, body: serialiseProvisionResult(outcome) }
      } finally {
        done()
      }
    }),

    /* -------------------------------------------------------------------- the world, read */

    define('GET', '/v1/wards', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      return { status: 200, body: { wards: await listWards(deps.sql) } }
    }),

    define('GET', '/v1/wards/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const ward = await findWard(deps.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { ward } }
    }),

    define('GET', '/v1/wards/:id/parcels', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const ward = await findWard(deps.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { parcels: await listParcelsIn(deps.sql, ward.id) } }
    }),

    define('GET', '/v1/wards/:id/presence', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const ward = await findWard(deps.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      return { status: 200, body: { avatars: await whoIsIn(deps.sql, ward.id) } }
    }),

    define('GET', '/v1/parcels/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await findParcel(deps.sql, id)
      if (!parcel) return errorReply(404, 'not_found', 'no such parcel', ctx.requestId)
      return {
        status: 200,
        body: { parcel, placements: await listPlacements(deps.sql, parcel.id) },
      }
    }),

    // The lazy fallow read. §4, §11.4: no sweep produced this list — it is a range scan against
    // the database's own clock, made when somebody asks.
    define('GET', '/v1/parcels/fallow', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      return { status: 200, body: { parcels: await listFallow(deps.sql) } }
    }),

    /* ------------------------------------------------------------------ discovery, read */

    // Two inputs, never three. `rankParcels` touches `visits` and `parcels` and nothing else;
    // there is no `promoted` column to join to and no query parameter that could order this
    // differently. §6.5, §7.1's first refusal.
    define('GET', '/v1/discover', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const wardParam = ctx.url.searchParams.get('wardId')
      const wardId = wardParam && UUID.test(wardParam) ? wardParam : null
      return { status: 200, body: { parcels: await rankParcels(deps.sql, wardId) } }
    }),

    // The one set of terms, for everybody. There is no `subject` parameter and there must not be.
    define('GET', '/v1/terms', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const terms = await platformTerms(deps.sql)
      return {
        status: 200,
        body: {
          ...terms,
          // Stated on the wire, because §7.2's fifth refusal is a promise to users and a promise
          // nobody can check is a marketing claim.
          identicalForEveryAccount: true,
        },
      }
    }),

    /* ------------------------------------------------------------------- the world, write */

    define('POST', '/v1/parcels', async (ctx, deps) => {
      const { principal, subject } = await requireUser(ctx, deps)
      const body = await readJson(ctx.req)
      const wardId = requireString(body, 'wardId')
      const tier = requireString(body, 'tier')
      if (!isTier(tier)) throw new BadRequestError('tier must be homestead, plot, court or quarter')
      const originX = requireInteger(body, 'originX', 0, 255)
      const originY = requireInteger(body, 'originY', 0, 255)

      // THERE IS NO PRICE HERE, AND THERE IS NO PAYMENT CALL. §4: land is claimed free and the
      // platform never sells it. `world.test.ts` asserts the absence of both from this file.
      const done = deps.lifecycle.track()
      try {
        const parcel = await claimParcel(deps.sql, {
          wardId,
          ownerSubject: subject,
          tier,
          originX,
          originY,
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('tessera_parcels_claimed_total', { tier: parcel.tier })
        ctx.log.info('parcel claimed', { parcelId: parcel.id, tier: parcel.tier, principal: principal.kind })
        return { status: 201, body: { parcel } }
      } finally {
        done()
      }
    }),

    define('POST', '/v1/parcels/:id/bank', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await bankParcel(deps.sql, {
        parcelId: id,
        ownerSubject: subject,
        correlationId: ctx.requestId,
      })
      return { status: 200, body: { parcel } }
    }),

    define('POST', '/v1/parcels/:id/contest', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      // The thirty days are checked by the DATABASE, on its own clock, inside the insert. This
      // route does not check them: a second answer to the same question is a second thing that
      // can be wrong, and only one of the two runs inside the transaction.
      const outcome = await openContest(deps.sql, {
        parcelId: id,
        challengerSubject: subject,
        correlationId: ctx.requestId,
      })
      return { status: 201, body: outcome }
    }),

    define('PATCH', '/v1/parcels/:id', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      const flags: { isVenue?: boolean; isWorkshop?: boolean; gateOpen?: boolean } = {}
      if (typeof body['isVenue'] === 'boolean') flags.isVenue = body['isVenue']
      if (typeof body['isWorkshop'] === 'boolean') flags.isWorkshop = body['isWorkshop']
      if (typeof body['gateOpen'] === 'boolean') flags.gateOpen = body['gateOpen']
      const parcel = await setParcelFlags(deps.sql, id, subject, flags)
      return { status: 200, body: { parcel } }
    }),

    /* --------------------------------------------------------------------------- the Kiln */

    define('POST', '/v1/kiln/firings', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      if (deps.kilnConfigured === false) {
        // An unconfigured upstream is a SUPPORTED mode, and it answers 503 rather than 500: the
        // rest of the world still works, and a world you can walk around in with a cold Kiln is
        // better than a title that refuses to boot over one dependency.
        return errorReply(503, 'kiln_unconfigured', 'the Kiln is not configured here', ctx.requestId)
      }
      const body = await readJson(ctx.req)
      const prompt = requireString(body, 'prompt')
      const category = requireString(body, 'category')
      if (!isCategory(category)) throw new BadRequestError('category is not one of the twelve')
      const footprint = requireString(body, 'footprint')
      if (footprint !== '1x1' && footprint !== '2x2') {
        throw new BadRequestError('footprint is 1x1 or 2x2 — there are two, and §6.3 says why')
      }
      const object = await requestFiring(deps.sql, {
        authorSubject: subject,
        prompt,
        category,
        footprint: footprint as Footprint,
        correlationId: ctx.requestId,
      })
      await deps.enqueueFiring?.(object.id, subject)
      deps.metrics.increment('tessera_firings_total', { footprint: object.footprint })
      // 202, like studio's own answer: the work is a leased job, not this request handler.
      return { status: 202, body: { object, statusUrl: `/v1/objects/${object.id}` } }
    }),

    define('GET', '/v1/objects/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('an object id is a uuid')
      const object = await findObject(deps.sql, id)
      if (!object) return errorReply(404, 'not_found', 'no such object', ctx.requestId)
      return { status: 200, body: { object } }
    }),

    define('GET', '/v1/objects', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      return { status: 200, body: { objects: await listObjectsOf(deps.sql, `user:${userId}`) } }
    }),

    define('POST', '/v1/parcels/:id/placements', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const parcelId = ctx.params['id'] ?? ''
      if (!UUID.test(parcelId)) throw new BadRequestError('a parcel id is a uuid')
      const parcel = await findParcel(deps.sql, parcelId)
      if (!parcel) return errorReply(404, 'not_found', 'no such parcel', ctx.requestId)
      if (parcel.ownerSubject !== subject) throw new ForbiddenError('this parcel is not yours')

      const body = await readJson(ctx.req)
      const raw = body['placements']
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new BadRequestError('placements must be a non-empty array')
      }
      // THE WHOLE BATCH IS ONE TRANSACTION, which is what makes the deferred object-cap trigger
      // check once rather than once per object — and what makes a paste that is legal only as a
      // whole legal at all. §11.6.
      const placements = raw.map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          throw new BadRequestError('each placement is an object')
        }
        const p = entry as Record<string, unknown>
        const objectId = requireString(p, 'objectId')
        const facing = typeof p['facing'] === 'string' ? p['facing'] : 'canonical'
        if (!(FACINGS as readonly string[]).includes(facing)) {
          throw new BadRequestError('facing is canonical or mirrored — there are two, and §2.1 says why')
        }
        return {
          parcelId,
          objectId,
          x: requireInteger(p, 'x', 0, 127),
          y: requireInteger(p, 'y', 0, 127),
          facing: facing as Facing,
          placedBy: subject,
        }
      })
      const outcome = await placeObjects(deps.sql, placements)
      return { status: 201, body: outcome }
    }),

    define('DELETE', '/v1/placements/:id', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a placement id is a uuid')
      await removePlacement(deps.sql, id, subject)
      return { status: 204 }
    }),

    /* ------------------------------------------------------------------------- the economy */

    define('POST', '/v1/listings', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const body = await readJson(ctx.req)
      const objectId = requireString(body, 'objectId')
      // A decimal STRING, never a JSON number: Number.MAX_SAFE_INTEGER is about 9e15 and a single
      // EMBER is 1e18 wei. `parsePriceWei` requires /^\d{1,78}$/ before BigInt, so the
      // BigInt('') === 0n hazard — a missing amount becoming a free purchase — is unreachable
      // through this door rather than handled behind it.
      const priceWei = parsePriceWei(body['priceWei'])
      const royaltyBps = requireInteger(body, 'royaltyBps', 0, 10_000)

      // NOTE what is NOT read from the body: `platformFeeBps` and `settlementMode`. The fee is
      // read from `platform_terms` and the mode is always custodial. A parameter that exists only
      // to be refused is a parameter somebody will one day wire to an entitlement. §7.2, §8.5.
      const listing = await draftListing(deps.sql, {
        objectId,
        sellerSubject: subject,
        priceWei,
        royaltyBps,
        correlationId: ctx.requestId,
      })
      return { status: 201, body: { listing: serialiseListing(listing) } }
    }),

    define('GET', '/v1/listings/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a listing id is a uuid')
      const listing = await findListing(deps.sql, id)
      if (!listing) return errorReply(404, 'not_found', 'no such listing', ctx.requestId)
      return { status: 200, body: { listing: serialiseListing(listing) } }
    }),

    define('GET', '/v1/listings', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const requested = ctx.url.searchParams.get('userId') ?? undefined
      const userId = isAdmin(principal) && requested ? requested : subjectUserId(principal, requested)
      const listings = await listListingsOf(deps.sql, `user:${userId}`)
      return { status: 200, body: { listings: listings.map(serialiseListing) } }
    }),

    /* ------------------------------------------------------------ presence and discovery */

    define('POST', '/v1/wards/:id/presence', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const ward = await findWard(deps.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      const body = await readJson(ctx.req)
      const avatar = await arrive(deps.sql, {
        wardId: ward.id,
        subject,
        x: requireInteger(body, 'x', 0, 255),
        y: requireInteger(body, 'y', 0, 255),
      })
      return { status: 200, body: { avatar } }
    }),

    define('DELETE', '/v1/wards/:id/presence', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const ward = await findWard(deps.sql, ctx.params['id'] ?? '')
      if (!ward) return errorReply(404, 'not_found', 'no such ward', ctx.requestId)
      await depart(deps.sql, ward.id, subject)
      return { status: 204 }
    }),

    define('POST', '/v1/parcels/:id/visits', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      // The visitor is the AUTHENTICATED subject and is never read from the body. A body-supplied
      // visitor is synthetic footfall with extra steps, and footfall is half the ranking function.
      // The database refuses a non-`user:` subject as well (§8.6), so this is the first of two.
      await recordVisit(deps.sql, {
        parcelId: id,
        visitorSubject: subject,
        dwellSeconds: requireInteger(body, 'dwellSeconds', 0, 86_400),
      })
      return { status: 204 }
    }),

    define('POST', '/v1/parcels/:id/beacons', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      const id = ctx.params['id'] ?? ''
      if (!UUID.test(id)) throw new BadRequestError('a parcel id is a uuid')
      const body = await readJson(ctx.req)
      try {
        const beacon = await lightBeacon(deps.sql, id, subject, requireString(body, 'headline'))
        return { status: 201, body: { beacon } }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('the limit is 3')) {
          throw new WorldError('beacon_rate_limited', message, 429)
        }
        throw err
      }
    }),

    /* ------------------------------------------------------------------------------- me */

    define('GET', '/v1/me/parcels', async (ctx, deps) => {
      const { subject } = await requireUser(ctx, deps)
      return { status: 200, body: { parcels: await listParcelsOf(deps.sql, subject) } }
    }),
  ]
}

/** A listing on the wire: every amount a decimal string, plus the Sparks the client prints. */
function serialiseListing(listing: {
  id: string
  objectId: string
  sellerSubject: string
  priceWei: bigint
  royaltyBps: number
  platformFeeBps: number
  settlementMode: string
  status: string
  split: { feeWei: bigint; royaltyWei: bigint; proceedsWei: bigint }
}): Record<string, unknown> {
  return {
    id: listing.id,
    objectId: listing.objectId,
    sellerSubject: listing.sellerSubject,
    priceWei: listing.priceWei.toString(),
    // Sparks is what the client PRINTS. It is not an asset code and it never appears in a ledger
    // posting — §8.1's rule, visible here as a display field beside the authoritative wei.
    priceSparks: toSparks(listing.priceWei).toString(),
    royaltyBps: listing.royaltyBps,
    platformFeeBps: listing.platformFeeBps,
    settlementMode: listing.settlementMode,
    status: listing.status,
    split: {
      feeWei: listing.split.feeWei.toString(),
      royaltyWei: listing.split.royaltyWei.toString(),
      proceedsWei: listing.split.proceedsWei.toString(),
      proceedsSparks: toSparks(
        listing.split.proceedsWei - (listing.split.proceedsWei % 1_000_000_000_000n),
      ).toString(),
    },
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than
  // being a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

/**
 * The write lane: a person, or a service acting for a named person.
 *
 * A service token must carry `tessera:write` AND name the user in `x-user-id`. That pairing is
 * aetherholm's and emberkin's (`aetherholm/src/server.ts:1034`, `emberkin/src/server.ts:453`),
 * and it is what lets a title act on a player's behalf without impersonating them — the same
 * shape studio offers Tessera in the other direction.
 */
async function requireUser(
  ctx: RequestContext,
  deps: ServerDeps,
): Promise<{ principal: Principal; subject: string }> {
  const principal = await authenticate(ctx, deps)
  if (principal.kind === 'service') {
    requireScope(principal, WRITE_SCOPE)
    const named = headerOf(ctx.req, 'x-user-id')
    if (!named || !UUID.test(named)) {
      throw new ForbiddenError('a service acting for a user must name them in x-user-id')
    }
    return { principal, subject: `user:${named}` }
  }
  return { principal, subject: `user:${subjectUserId(principal)}` }
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function requireInteger(
  body: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestError(`${field} must be a whole number between ${min} and ${max}`)
  }
  return value
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // Capped before buffering, not after: an unbounded body is a memory exhaustion primitive that
    // any unauthenticated caller can reach.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? (reply.status === 204 ? '' : `${JSON.stringify(reply.body ?? {})}\n`)
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    // Health and metrics answers are a point-in-time fact. A cached 200 from a replica that has
    // since gone unready is exactly the lie the lifecycle package exists to stop telling.
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
