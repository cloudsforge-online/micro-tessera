/**
 * The title contract: the two routes `micro-worlds` actually calls.
 *
 * §11.8: "`worlds` calls exactly two routes, despite its own client header saying four
 * (`worlds/src/titleclient.ts:7`): `GET /v1/title` returning `{slug, name, capabilities[]}`, and
 * `POST /v1/provision` taking `{entitlementId, subject, userId, sku, scope, metadata}` and
 * returning `{urn, replayed}`, with the `entitlementId` sent as **both** the `Idempotency-Key`
 * header and a body field."
 *
 * Both paths, both shapes and the URN builder come from `@cloudsforge/contracts-worlds`, so this
 * service cannot serve a route worlds does not call, nor a body it does not send. That is the
 * exact failure the achievement bridge suffered in the other direction: two title clients POSTed
 * `/internal/achievements` for months and worlds never served it.
 */

import {
  parseTitleUrn,
  titleUrn,
  type Capability,
  type ProvisionRequest,
  type ProvisionResult,
  type TitleDescriptor,
} from '@cloudsforge/contracts-worlds'
import type { Db } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { ARCHETYPES, ensureAccount, openWard, WorldError, type Archetype } from './world.ts'

/** This title's slug in worlds' registry — the one place it is spelled. */
export const TITLE_SLUG = 'tessera'

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE CAPABILITIES, TYPED, AND ONE OF THEM IS THE POINT.
 *
 * §11.8: "Tessera declares **`['private_world', 'cosmetics', 'inventory']`**. `private_world` is
 * the one that matters: the provisioning bridge calls a title only when that capability holds
 * (`worlds/src/provisioning.ts:441-451`), and provisioning a **Private Ward** is how the existing,
 * currently-unserved `world.private.small` SKU (`billing/src/migrations.ts:405`) finally gets a
 * code path."
 *
 * Typed `readonly Capability[]` and not `string[]`, which is a correction to what aetherholm does:
 * `contracts/packages/worlds/src/index.ts:110-120` records that `aetherholm/src/server.ts:107-111`
 * "builds its descriptor from a bare string literal ... with nothing to check it against", and
 * that a typo there "turns a typo in a registration into a purchase that is accepted and never
 * provisioned". A misspelled capability here is a compile error.
 *
 * `achievements` and `seasons` are deliberately absent. Declaring a capability this title does not
 * deliver is a purchase taken for something it cannot make — worlds' conformance check 4 exists
 * because that has happened.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const CAPABILITIES: readonly Capability[] = Object.freeze([
  'private_world',
  'cosmetics',
  'inventory',
])

export const TITLE_DESCRIPTOR: TitleDescriptor = Object.freeze({
  slug: TITLE_SLUG,
  name: 'Tessera',
  capabilities: CAPABILITIES,
})

/**
 * The SKUs this title can actually deliver, and what each provisions.
 *
 * A closed map, so an unknown SKU is a 422 `unsupported` — the contract's own status for "this
 * title cannot deliver that" — rather than a silent success that bills somebody for nothing.
 *
 * `world.private.small` is the row §7.3 and §11.8 both point at: it already exists in
 * `billing/src/migrations.ts:405` (750, 30-day, title-scoped) and **no title serves it today**.
 * This is the code path.
 */
export const SERVED_SKUS: Readonly<Record<string, { kind: string; archetype: Archetype }>> =
  Object.freeze({
    'world.private.small': Object.freeze({ kind: 'ward', archetype: 'ashfield' as Archetype }),
  })

export function servesSku(sku: string): boolean {
  return Object.hasOwn(SERVED_SKUS, sku)
}

/**
 * Provision, idempotently on `entitlementId`.
 *
 * §12's test 11: "provision replays idempotently on `entitlementId` — same `urn`, `replayed: true`
 * on the second ask, the way `worlds/src/conformance.ts:233-246` checks it."
 *
 * The idempotency is the PRIMARY KEY on `provisions.entitlement_id`, not a check-then-insert: two
 * bridge replicas redelivering one entitlement both run this, and exactly one insert wins. A
 * check-then-insert would let both pass the check and both raise a ward.
 *
 * The URN is built by `titleUrn` from the contract and then parsed back by `parseTitleUrn` before
 * it is stored. Parsing your own output looks redundant and is not: `contracts-worlds` records
 * that aetherholm builds its URN by template literal and never checks it, so a URN of the wrong
 * shape "is recorded and pointed at for ever". This is one line that makes that impossible, and
 * `provisions_urn_is_a_title_urn` is the same statement in the database.
 */
export async function provision(
  sql: Db,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const existing = await sql<{ urn: string }[]>`
    select urn from provisions where entitlement_id = ${request.entitlementId}
  `
  const already = existing[0]
  if (already) return { urn: already.urn, replayed: true }

  const served = SERVED_SKUS[request.sku]
  if (!served) {
    throw new WorldError(
      'unsupported',
      `${TITLE_SLUG} does not serve the sku ${request.sku}`,
      // 422 `unsupported` is the contract's own answer (UNSUPPORTED_STATUS / UNSUPPORTED_CODE),
      // and it is distinct from 400: the request was well-formed, this title just cannot deliver
      // it, which is a fact about the title and not a mistake by the caller.
      422,
    )
  }

  const name = wardNameFrom(request)
  const slug = wardSlugFrom(request)

  return withOutbox(sql, async (tx) => {
    await ensureAccount(tx, request.subject)
    // The ward is minted inside the same transaction as the provision row, so a crash cannot
    // leave a paid entitlement with no ward or a ward with nothing that paid for it.
    const wards = await tx<{ id: string }[]>`
      insert into wards (slug, name, archetype, ordinal, claimable_tiles)
      select ${slug}, ${name}, ${served.archetype}, coalesce(max(ordinal) + 1, 0), 49152
        from wards
      returning id
    `
    const ward = wards[0]
    if (!ward) throw new WorldError('not_provisioned', 'the ward could not be minted')

    const urn = titleUrn({ title: TITLE_SLUG, kind: served.kind, id: ward.id })
    const parsed = parseTitleUrn(urn)
    if (!parsed.ok) {
      // Unreachable unless the contract's builder and its parser disagree, which is exactly the
      // pair worth asserting rather than assuming — and cheaper to assert here, once per
      // provision, than to discover in worlds' registry.
      throw new WorldError('bad_urn', parsed.errors.join('; '), 500)
    }

    const rows = await tx<{ urn: string }[]>`
      insert into provisions (entitlement_id, subject, user_id, sku, scope, urn, ward_id, metadata)
      values (${request.entitlementId}, ${request.subject}, ${request.userId}, ${request.sku},
              ${request.scope}, ${urn}, ${ward.id}, ${tx.json(request.metadata as Record<string, never>)})
      on conflict (entitlement_id) do nothing
      returning urn
    `
    const row = rows[0]
    if (!row) {
      // The other replica won the race between the SELECT above and this INSERT. Read back what
      // it wrote and report a replay — which is the truth, and is what the bridge expects.
      const winner = await tx<{ urn: string }[]>`
        select urn from provisions where entitlement_id = ${request.entitlementId}
      `
      const won = winner[0]
      if (!won) throw new WorldError('not_provisioned', 'the provision did not land')
      return { urn: won.urn, replayed: true }
    }
    return { urn: row.urn, replayed: false }
  })
}

/**
 * A ward name from whatever billing carried on the grant.
 *
 * `metadata` is free-form by the contract's own declaration, so it is read defensively and never
 * trusted into a constraint: a `name` that is not a string, or is empty, or is 400 characters, is
 * replaced rather than 400'd. A provisioning bridge that has already taken somebody's money is the
 * wrong place to refuse over a display name.
 */
export function wardNameFrom(request: ProvisionRequest): string {
  const supplied = request.metadata['name']
  if (typeof supplied === 'string') {
    const trimmed = supplied.trim()
    if (trimmed.length > 0 && trimmed.length <= 80) return trimmed
  }
  return `Private Ward ${request.entitlementId.slice(0, 8)}`
}

/**
 * The ward's slug. Derived from the entitlement id, not from the name.
 *
 * A slug derived from a user-supplied name is a slug two users can collide on, and the collision
 * surfaces as a unique-violation on somebody's paid provision. The entitlement id is already
 * unique and already the idempotency key.
 */
export function wardSlugFrom(request: ProvisionRequest): string {
  const suffix = request.entitlementId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
  return `private-${suffix || 'ward'}`
}

/** Every archetype a private ward may be minted as. Re-exported so tests need one import. */
export { ARCHETYPES, openWard }
