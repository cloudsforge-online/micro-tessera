/**
 * The Kiln's upstream: `micro-studio`.
 *
 * §9.1's flow, against the source:
 *
 *   1. Tessera calls studio with a service token holding `studio:write`. A **service** principal
 *      skips ownership narrowing entirely — `assertOwned` returns early at
 *      `studio/src/server.ts:561` — and names the acting user via `body.userId` (`subjectOf`,
 *      `studio/src/server.ts:533-536`). So a title generates on a player's behalf without
 *      impersonating them.
 *   2. Studio answers **202 with a `statusUrl`** (`studio/src/server.ts:454-465`). Generation is a
 *      leased job on studio's side too, so this client polls that URL rather than holding a socket
 *      open for a minute of diffusion.
 *   3. The checksum comes back `sha256:<hex>` (`studio/src/assets.ts:77-79`) and IS the object's
 *      identity.
 *   4. `c2pa` is **measured off the bytes** by studio — `outcome.bytes.includes(C2PA_MARKER)` at
 *      `studio/src/backend.ts:460`, under the comment "Read from the bytes rather than assumed" —
 *      and carried through here unchanged. This client never sets it, defaults it or infers it.
 *
 * **The polling here is inside a leased job, not a timer.** It is a bounded `await` loop with an
 * `AbortSignal`, run by `kiln.fire`, which is a leased job claimed `for update skip locked`. That
 * is a different thing from a `setInterval`: it holds a lease, it stops when the lease is lost or
 * the process drains, and exactly one replica is doing it.
 */

import { HttpClient } from '@cloudsforge/http'
import { OBJECT_CANVAS, STUDIO_ASSET_KIND } from './kiln.ts'

export interface GenerateInput {
  readonly objectId: string
  readonly subject: string
  readonly prompt: string
  readonly signal: AbortSignal
}

export interface GenerateOutcome {
  readonly assetId: string
  /** `sha256:<64 hex>` — studio's own spelling, carried through without reformatting. */
  readonly checksum: string
  /** Measured off the bytes by studio. Never asserted here. */
  readonly c2pa: boolean
}

export interface StudioClient {
  generate(input: GenerateInput): Promise<GenerateOutcome>
}

export class StudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StudioError'
  }
}

export interface StudioClientOptions {
  readonly baseUrl: string
  /** A live service token holding `studio:write`. A function, because a token expires. */
  readonly token: () => Promise<string>
  readonly pollIntervalMs?: number
  readonly maxWaitMs?: number
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

/**
 * The prompt template of §2.6, applied to a user's description.
 *
 * The projection, the light and the ground are NOT the user's to choose: they are what makes one
 * player's chair sit in the same world as another player's chair. §1's whole argument for
 * painterly is that user content cannot look bad because the thing making it is a painter working
 * to one brief — a brief the user could override is not a brief.
 *
 * `#12100f` is the estate's pinned ground (`brand/normalise_ground.py:27`), because diffusion does
 * not emit alpha and the cutout step keys against a known colour. §2.1.
 */
export function promptFor(description: string): string {
  return (
    `single ${description} in painterly gouache, three-quarter isometric view from above-left, ` +
    '2:1 dimetric, standing alone on a flat #12100f ground, warm ash-and-ember key light from ' +
    'the upper left, cool shadow, no outline, no bevel, no gloss, no background, no other objects'
  )
}

export function createStudioClient(options: StudioClientOptions): StudioClient {
  const http =
    options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'studio' })
  const pollIntervalMs = options.pollIntervalMs ?? 2_000
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000

  return {
    async generate(input) {
      const token = await options.token()
      const started = await http.request('/v1/generations', {
        method: 'POST',
        deadlineMs: 15_000,
        // The event/job id is the idempotency key, so a retried job does not pay for a second
        // generation. Studio's credit ledger holds real USD (`studio/src/credits.ts:43`).
        idempotencyKey: input.objectId,
        headers: { authorization: `Bearer ${token}` },
        body: {
          // Names the acting user WITHOUT impersonating them — the shape studio's service lane
          // exists for (`subjectOf`, studio/src/server.ts:533-536).
          userId: input.subject.startsWith('user:') ? input.subject.slice('user:'.length) : input.subject,
          kind: STUDIO_ASSET_KIND,
          prompt: promptFor(input.prompt),
          // `width`/`height`, NEVER `aspect_ratio`. FLUX ignores aspect_ratio; the wire contract is
          // pinned at studio/src/backend.ts:12-17 and the lesson is repeated in all three asset
          // repos' generator headers. Both are multiples of 16 — FLUX floors to a 16-pixel grid
          // (studio/src/specs.ts:126-133) — so 512 needs no rounding.
          width: OBJECT_CANVAS,
          height: OBJECT_CANVAS,
        },
      })

      const statusUrl = readString(started, 'statusUrl')
      if (!statusUrl) throw new StudioError('studio returned no statusUrl')

      const deadline = Date.now() + maxWaitMs
      while (Date.now() < deadline) {
        if (input.signal.aborted) throw new StudioError('the firing was aborted')
        const status = await http.request(pathOf(statusUrl), {
          method: 'GET',
          deadlineMs: 10_000,
          headers: { authorization: `Bearer ${await options.token()}` },
        })
        const state = readString(status, 'status') ?? readString(status, 'state')
        if (state === 'succeeded' || state === 'complete' || state === 'completed') {
          const checksum = readString(status, 'checksum')
          const assetId = readString(status, 'assetId') ?? readString(status, 'id')
          if (!checksum || !assetId) {
            throw new StudioError('studio reported success with no checksum or asset id')
          }
          if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) {
            // Refused rather than normalised: the checksum IS the object's identity, and a client
            // that reformatted it would be the one place two spellings of one address could be
            // born. `tessera_objects_are_their_bytes` is a unique index on this exact string.
            throw new StudioError(`studio returned a checksum of an unexpected shape: ${checksum}`)
          }
          return {
            assetId,
            checksum,
            // Read, never defaulted to true. `?? false` is the only safe default: asserting c2pa
            // that was not measured is precisely what §2.2 says makes a repo "wrong quietly".
            c2pa: readBoolean(status, 'c2pa') ?? false,
          }
        }
        if (state === 'failed' || state === 'dead') {
          throw new StudioError(readString(status, 'error') ?? 'studio reported the generation failed')
        }
        await sleep(pollIntervalMs, input.signal)
      }
      throw new StudioError(`studio did not finish within ${maxWaitMs}ms`)
    },
  }
}

function pathOf(statusUrl: string): string {
  try {
    const parsed = new URL(statusUrl)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return statusUrl.startsWith('/') ? statusUrl : `/${statusUrl}`
  }
}

function readString(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[field]
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function readBoolean(value: unknown, field: string): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = (value as Record<string, unknown>)[field]
  return typeof v === 'boolean' ? v : undefined
}

/**
 * An abortable sleep.
 *
 * `setTimeout`, not `setInterval`, and it does no domain work — it waits between two polls inside
 * a leased job. The CI grep at `service-ci.yml:1036-1056` looks for `setInterval`; this is the
 * shape it is not looking for, and the reason is real rather than a technicality: an interval
 * fires whether or not the previous tick finished and outlives the lease that authorised it.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
