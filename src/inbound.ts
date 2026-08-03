/**
 * The inbox: events this service receives from other producers.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SIGNATURE IS VERIFIED OVER THE RAW BYTES, BEFORE THEY ARE PARSED. THE ORDER IS THE
 * SECURITY PROPERTY.**
 *
 * `activity/src/ingest.ts:83-95` does this and its header at `:76-82` explains why re-serialising
 * before verifying is forbidden: `JSON.parse` then `JSON.stringify` is not the identity function —
 * key order, number formatting and unicode escapes all change — so a MAC recomputed over the
 * re-serialised body is a MAC over different bytes, and every honest delivery is refused while the
 * failure looks like a secret mismatch.
 *
 * Parsing first would also put a JSON parser in front of the authentication, reachable by anyone
 * who can open a socket. `analytics` and `admin-api` both moved their ingest routes to MAC-only
 * for this reason, and `contracts-auth`'s two deprecated scopes record what happened when the
 * bearer was treated as the wall instead.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * And the envelope is judged by `classifyEnvelope`, never by a hand-rolled shape check. Its three
 * verdicts are distinct on purpose and this file keeps them distinct:
 *
 *   * `valid`                — handle it.
 *   * `unregistered_topic`   — the producer emitted something `contracts-events` does not know.
 *                              202, recorded, NOT handled. Refusing with a 4xx would make the
 *                              producer retry for ever; handling it would mean acting on a payload
 *                              with no registered shape.
 *   * `malformed`            — 400 with the defects, which name exactly what the producer must fix.
 */

import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  classifyEnvelope,
  verifyDelivery,
  type EventEnvelope,
} from '@cloudsforge/contracts-events'
import type { Logger } from '@cloudsforge/telemetry'
import type { Db, Tx } from './outbox.ts'
import { withInbox } from './outbox.ts'
import { markSold } from './economy.ts'
import { CONSUMED } from './topics.ts'

export type InboundVerdict =
  | { readonly status: 200 | 202; readonly outcome: 'processed' | 'duplicate' | 'unregistered' | 'ignored' }
  | { readonly status: 400 | 401; readonly outcome: 'malformed' | 'unauthenticated'; readonly detail: string }

export interface InboundDeps {
  readonly sql: Db
  readonly logger: Logger
  /** Every secret that may have signed an inbound delivery. Rotation is a list, not a swap. */
  readonly secrets: readonly string[]
}

/**
 * Handle one delivery.
 *
 * `raw` is the exact bytes the socket carried. It is a `string` rather than a parsed object in the
 * signature so that a caller CANNOT pass a re-serialised body — the mistake is unrepresentable at
 * the type level rather than warned about in a comment.
 */
export async function handleDelivery(
  deps: InboundDeps,
  raw: string,
  headers: Readonly<Record<string, string | undefined>>,
): Promise<InboundVerdict> {
  const presented = headers[SIGNATURE_HEADER]
  if (!presented) {
    return { status: 401, outcome: 'unauthenticated', detail: `no ${SIGNATURE_HEADER}` }
  }

  // Multi-secret rotation and the 5-minute freshness window both live in the contract's verifier,
  // along with the `timingSafeEqual` comparison. A local implementation is exactly what the §3.3p
  // repair found five producers had drifted into.
  const verified = deps.secrets.some((secret) => verifyDelivery(raw, presented, secret).ok)
  if (!verified) {
    // The reason is not returned. "Expired" versus "forged" tells an attacker which half to fix.
    deps.logger.info('rejected an unsigned or badly signed delivery')
    return { status: 401, outcome: 'unauthenticated', detail: 'signature' }
  }

  // ONLY NOW is the body parsed.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 400, outcome: 'malformed', detail: 'body is not valid JSON' }
  }

  const verdict = classifyEnvelope(parsed)
  if (!verdict.ok) {
    if (verdict.reason === 'unregistered_topic') {
      // 202, not 400: the delivery is authentic and the producer cannot fix it by retrying. The
      // topic needs registering in `contracts-events`, which is a pull request, not a redelivery.
      deps.logger.warn('an authentic delivery named an unregistered topic', {
        topic: verdict.unregisteredTopic,
      })
      return { status: 202, outcome: 'unregistered' }
    }
    deps.logger.warn('a delivery was malformed', { defects: verdict.defects })
    return { status: 400, outcome: 'malformed', detail: verdict.defects.join('; ') }
  }

  const envelope = verdict.value
  const eventId = headers[EVENT_ID_HEADER] ?? envelope.id
  if (!(CONSUMED as readonly string[]).includes(envelope.topic)) {
    // Subscribed to something this service has no handler for. Recorded and ignored rather than
    // errored: a subscription is configuration, and a configuration mistake must not look like an
    // outage to the producer's relay.
    return { status: 202, outcome: 'ignored' }
  }

  const outcome = await withInbox(deps.sql, envelope.topic, eventId, async (tx) => {
    await apply(tx, envelope)
  })
  return { status: 200, outcome: outcome.status === 'duplicate' ? 'duplicate' : 'processed' }
}

/**
 * What each consumed topic does.
 *
 * Runs INSIDE the inbox transaction, which is what makes a failed handler leave no inbox row and
 * the redelivery be processed rather than swallowed — the mistake a naive "record then handle"
 * dedupe makes.
 */
async function apply(tx: Tx, envelope: EventEnvelope): Promise<void> {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>
  switch (envelope.topic) {
    case 'market.listing.sold': {
      const listingId = payload['listingId']
      if (typeof listingId === 'string') {
        await markSold(tx as unknown as Db, listingId)
      }
      return
    }

    /**
     * §10.2's argument, implemented.
     *
     * "community's execution handler does nothing for any kind except `treasury_spend`
     * (`community/src/executions.ts:217-219`), so a design that expected community to *enact* a
     * world change would have needed a new execution kind and a new handler in somebody else's
     * repo. Putting the effect in Tessera keeps the change count at zero and puts the game logic
     * in the game."
     *
     * A ward's community decides ward parameters by `parameter_change` proposal; the effect
     * happens here. What a ward may change is deliberately narrow and, notably, does not include
     * anything §7.1 refuses: a ward cannot vote itself a discovery boost, a lower fee, or more
     * object cap, because there is no branch that would apply one.
     */
    case 'community.proposal.executed': {
      const communityId = payload['communityId']
      const parameter = payload['parameter']
      const value = payload['value']
      if (typeof communityId !== 'string') return
      if (parameter === 'wardName' && typeof value === 'string' && value.trim().length > 0) {
        await tx`
          update wards set name = ${value.trim().slice(0, 80)} where community_id = ${communityId}
        `
      }
      return
    }

    case 'billing.entitlement.granted': {
      const subject = payload['subject']
      const sku = payload['sku']
      const entitlementId = payload['entitlementId']
      if (typeof subject !== 'string' || typeof sku !== 'string' || typeof entitlementId !== 'string') {
        return
      }
      const kind = entitlementKindFor(sku)
      // An unknown SKU writes nothing. `entitlements_kind_known` would refuse it anyway, and a
      // handler that raised would make the producer's relay retry a fact it cannot change.
      if (!kind) return
      await tx`
        insert into entitlements (subject, kind, sku, entitlement_id)
        values (${subject}, ${kind}, ${sku}, ${entitlementId})
        on conflict (entitlement_id) do nothing
      `
      // ═════════════════════════════════════════════════════════════════════════════════════
      // A DEED SLOT GRANT RAISES THE ALLOWANCE — AND THE CEILING IS NOT NEGOTIATED HERE.
      //
      // `least(deed_slots + 1, 12)` looks like the cap, and it is not: `tessera_deed_slots_capped`
      // is. If this line said `deed_slots + 1` the database would refuse the thirteenth, which is
      // §7.3's "capped at 12 by CHECK, at any price" doing its job. The `least` is here so the
      // thirteenth purchase is a no-op rather than a 500 — a courtesy, not the rule — and
      // `economy.test.ts` proves the rule by removing the `least` and watching the CHECK fire.
      // ═════════════════════════════════════════════════════════════════════════════════════
      if (kind === 'deed_slots') {
        await tx`
          update accounts set deed_slots = least(deed_slots + 1, 12) where subject = ${subject}
        `
      }
      return
    }

    case 'billing.entitlement.revoked': {
      const entitlementId = payload['entitlementId']
      if (typeof entitlementId !== 'string') return
      await tx`
        update entitlements set revoked_at = now()
         where entitlement_id = ${entitlementId} and revoked_at is null
      `
      return
    }

    default:
      return
  }
}

/**
 * Which of this title's entitlement kinds a billing SKU maps to.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MAP IS THE REFUSAL.** §7.3's table has six SKUs and §7.1 has five refusals, and this
 * function is where the two meet: there is no `sku` string that returns `'discovery'`,
 * `'vote_weight'`, `'safety'`, `'land'` or `'fee_discount'`, because those are not values of the
 * return type and not values of `entitlements_kind_known`.
 *
 * So a billing SKU named `tessera.boost.featured` does not fail a validation — it has nowhere to
 * go. §12's test 4 asserts each of the six absences with force, the way `admin-web` asserts its
 * missing og card, rather than trusting this paragraph.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function entitlementKindFor(sku: string): string | null {
  if (sku === 'world.private.small') return 'private_ward'
  if (sku.startsWith('tessera.kiln.')) return 'kiln_capacity'
  if (sku.startsWith('tessera.deed.')) return 'deed_slots'
  if (sku.startsWith('tessera.appearance.')) return 'appearance'
  if (sku.startsWith('tessera.name.')) return 'name_reservation'
  if (sku.startsWith('tessera.venue.')) return 'venue_calendar'
  return null
}
