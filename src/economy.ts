/**
 * Listings, venue bookings, and engagement grants.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE WORLD CANNOT PAY OUT EMBER IT DOES NOT HOLD, AND THAT IS A TRIGGER IN SOMEBODY ELSE'S
 * DATABASE.
 *
 * §8.3: "Every grant Tessera makes debits `engagement:tessera`, which is an **`equity`** account,
 * so the ledger's no-overdraft trigger refuses an unfunded grant at the database. `micro-market`
 * proves the pattern already works: `market/src/engagement.ts:22-29` names `engagementAccount`
 * from `contracts-money` with `equity` type precisely 'so the ledger's no-overdraft rule refuses
 * an unfunded grant'. This is what 'chain-backed by construction' actually reduces to in code:
 * **not a promise that reserves exist, but a constraint that makes spending non-existent reserves
 * unrepresentable.**"
 *
 * `ledger_assert_no_overdraft` exempts `clearing` and `suspense`; it does not exempt `equity`
 * (`ledger/src/migrations.ts:441`, `:479`). So the refusal is not something this file implements —
 * it is something this file is careful not to route around. The account key comes from
 * `engagementAccount` in `@cloudsforge/contracts-money` rather than being spelled here, because
 * an account is `(subject, asset_code, purpose)` and a second spelling would silently split the
 * programme's ledger in half: `ledger/src/accounts.ts` throws on a type mismatch, and whichever
 * service posts second has EVERY entry refused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Every grant names its ledger entry and cannot be written before it.** `ledger_entry_id` is NOT
 * NULL (migration 6), the rule doc 21 §7.4 states and `micro-market` already follows. So the order
 * is always: post to the ledger on a key derived from the grant, then record. A crash between them
 * leaves an entry with no row — the safe direction, visible in the ledger, adopted by the retry —
 * never a recorded payment that never happened.
 */

import { ENGAGEMENT_GRANT_KIND, engagementAccount, type AccountIdentity } from '@cloudsforge/contracts-money'
import type { Db } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import { VENUE_BOOKED } from './topics.ts'
import { ASSET, parsePriceWei, splitSale, type SaleSplit } from './sparks.ts'
import { ensureAccount, WorldError } from './world.ts'
import { SERVICE } from './env.ts'

/**
 * The account every grant debits. **`engagement:tessera`, `EMBER`, and an `equity` type.**
 *
 * Spelled by the contract, not here. The `equity` type is the whole safety property — see the file
 * header.
 */
export const ENGAGEMENT_ACCOUNT: AccountIdentity = engagementAccount(SERVICE, ASSET)

/** The entry kind an engagement grant posts under. `treasury_spend`, from the contract. */
export const GRANT_ENTRY_KIND = ENGAGEMENT_GRANT_KIND

/**
 * The purpose a creator's proceeds land in before they clear.
 *
 * §8.2: "Sale proceeds sit in `user:<id> / EMBER / payout_due` for the listing's dispute window,
 * then release to `available`." It is **visible** — a real balance in a real account — and
 * **structurally unspendable**, because nothing in Tessera ever debits `payout_due` except the
 * release, and a spend attempt against it would be an overdraft the ledger's
 * `ledger_assert_no_overdraft` trigger refuses.
 */
export const PAYOUT_DUE = 'payout_due' as const
export const AVAILABLE = 'available' as const

export interface Listing {
  readonly id: string
  readonly objectId: string
  readonly sellerSubject: string
  readonly priceWei: bigint
  readonly royaltyBps: number
  readonly platformFeeBps: number
  readonly settlementMode: 'custodial'
  readonly marketListingId: string | null
  readonly status: 'draft' | 'active' | 'sold' | 'withdrawn'
  readonly createdAt: string
  /** What the seller will actually receive, computed the way market computes it. `sparks.ts`. */
  readonly split: SaleSplit
}

interface ListingRow {
  readonly id: string
  readonly object_id: string
  readonly seller_subject: string
  readonly price_wei: string
  readonly royalty_bps: number
  readonly platform_fee_bps: number
  readonly settlement_mode: string
  readonly market_listing_id: string | null
  readonly status: string
  readonly created_at: Date
}

const LISTING_COLUMNS = `id, object_id, seller_subject, price_wei::text as price_wei, royalty_bps,
  platform_fee_bps, settlement_mode, market_listing_id, status, created_at`

export function toListing(row: ListingRow): Listing {
  // `::text` then `BigInt`, never a JSON number — `market/src/escrow.ts:100-102` reads amounts the
  // same way, for the same reason: postgres.js hands back numeric as a string, and turning it into
  // a Number on the way through would round at 2^53 while a single EMBER is 10^18 wei.
  const priceWei = parsePriceWei(row.price_wei, 'price_wei')
  return {
    id: row.id,
    objectId: row.object_id,
    sellerSubject: row.seller_subject,
    priceWei,
    royaltyBps: row.royalty_bps,
    platformFeeBps: row.platform_fee_bps,
    settlementMode: 'custodial',
    marketListingId: row.market_listing_id,
    status: row.status as Listing['status'],
    createdAt: row.created_at.toISOString(),
    split: splitSale({
      priceWei,
      platformFeeBps: row.platform_fee_bps,
      royaltyBps: row.royalty_bps,
    }),
  }
}

export interface PlatformTerms {
  readonly platformFeeBps: number
  readonly maxRoyaltyBps: number
}

/**
 * The one set of terms, for everybody.
 *
 * There is no `subject` argument on this function and there must not be one. §7.2's fifth
 * refusal: "The platform fee and the royalty cap are **identical for every account**, and **no
 * SKU, tier or subscription reduces either**." A per-account rate would need a parameter here
 * before it needed a column anywhere, so the absence of the parameter is the first place the
 * refusal is visible — and `economy.test.ts` asserts the signature takes no subject, the way
 * `admin-web` asserts its missing og card.
 */
export async function platformTerms(sql: Db): Promise<PlatformTerms> {
  const rows = await sql<{ platform_fee_bps: number; max_royalty_bps: number }[]>`
    select platform_fee_bps, max_royalty_bps from platform_terms where singleton
  `
  const row = rows[0]
  if (!row) throw new WorldError('terms_unset', 'the platform terms are unset', 503)
  return { platformFeeBps: row.platform_fee_bps, maxRoyaltyBps: row.max_royalty_bps }
}

export interface DraftListingInput {
  readonly objectId: string
  readonly sellerSubject: string
  readonly priceWei: bigint
  readonly royaltyBps: number
  readonly correlationId: string
}

/**
 * Draft a listing for an object.
 *
 * The platform fee is READ from `platform_terms` and never accepted from the caller. A caller that
 * could pass a fee could pass a lower one; the trigger `listings_one_rate_for_everybody` would
 * refuse it, but a parameter that exists only to be refused is a parameter somebody will one day
 * wire to an entitlement.
 *
 * `settlement_mode` is not a parameter either. §8.5: for an `onchain` listing "the royalty is
 * recorded on the order row and **never posted**. Therefore: **every Tessera listing is
 * `custodial`, without exception.** That is not a preference; it is the only mode in which the
 * royalty exists."
 */
export async function draftListing(sql: Db, input: DraftListingInput): Promise<Listing> {
  const terms = await platformTerms(sql)
  if (input.royaltyBps < 0 || input.royaltyBps > terms.maxRoyaltyBps) {
    throw new WorldError(
      'royalty_out_of_range',
      `a royalty must be between 0 and ${terms.maxRoyaltyBps} bps — the cap is identical for every account (23-tessera.md §7.2)`,
      400,
    )
  }
  try {
    return await withOutbox(sql, async (tx) => {
      await ensureAccount(tx, input.sellerSubject)
      const owns = await tx<{ author_subject: string; status: string }[]>`
        select author_subject, status from objects where id = ${input.objectId}
      `
      const object = owns[0]
      if (!object) throw new WorldError('not_found', 'no such object', 404)
      if (object.status !== 'fired') {
        throw new WorldError('not_fired', 'an object must finish firing before it can be listed', 409)
      }
      const rows = await tx<ListingRow[]>`
        insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
        values (${input.objectId}, ${input.sellerSubject}, ${input.priceWei.toString()}::numeric,
                ${input.royaltyBps}, ${terms.platformFeeBps})
        returning ${tx.unsafe(LISTING_COLUMNS)}
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_listed', 'the listing did not land')
      return toListing(row)
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_price_whole_sparks')) {
      throw new WorldError(
        'price_not_whole_sparks',
        'a price must be a whole number of Sparks (23-tessera.md §8.1)',
        400,
      )
    }
    if (message.includes('the rate is identical for every account')) {
      throw new WorldError('rate_is_not_negotiable', message, 409)
    }
    throw err
  }
}

/** Bind a draft to the micro-market listing it became. */
export async function activateListing(
  sql: Db,
  listingId: string,
  marketListingId: string,
): Promise<Listing> {
  const rows = await sql<ListingRow[]>`
    update listings set status = 'active', market_listing_id = ${marketListingId}
     where id = ${listingId} and status = 'draft'
    returning ${sql.unsafe(LISTING_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new WorldError('not_found', 'no such draft listing', 404)
  return toListing(row)
}

/** Consume `market.listing.sold`. The money moved in market's ledger entry; this records the fact. */
export async function markSold(sql: Db, marketListingId: string): Promise<void> {
  await sql`
    update listings set status = 'sold' where market_listing_id = ${marketListingId}
  `
}

export async function findListing(sql: Db, id: string): Promise<Listing | null> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings where id = ${id}
  `
  const row = rows[0]
  return row ? toListing(row) : null
}

export async function listListingsOf(sql: Db, subject: string): Promise<Listing[]> {
  const rows = await sql<ListingRow[]>`
    select ${sql.unsafe(LISTING_COLUMNS)} from listings
     where seller_subject = ${subject} order by created_at desc limit 100
  `
  return rows.map(toListing)
}

/* -------------------------------------------------------------------------------- bookings */

export interface BookInput {
  readonly parcelId: string
  readonly slot: Date
  readonly bookedBy: string
  readonly priceWei: bigint
  /** The ledger reservation that holds the money. An open booking without one is refused. */
  readonly reservationId: string
  readonly correlationId: string
}

/**
 * Book a slot on a Venue's calendar, against an escrowed ledger hold.
 *
 * §8.2's shape, not a new one: "Reserving funds is a posting from `available` to `reserved`, which
 * makes a reservation auditable, reversible and impossible to lose track of"
 * (`ledger/src/accounts.ts:9`). The reservation is taken by the route before this is called, and
 * `bookings_open_holds_money` refuses an open booking that names none — so a free hold on somebody
 * else's calendar is unrepresentable rather than discouraged.
 */
export async function bookVenue(sql: Db, input: BookInput): Promise<{ bookingId: string }> {
  try {
    return await withOutbox(sql, async (tx, emit) => {
      await ensureAccount(tx, input.bookedBy)
      const rows = await tx<{ id: string; parcel_id: string; slot: Date }[]>`
        insert into bookings (parcel_id, slot, booked_by, price_wei, reservation_id)
        values (${input.parcelId}, ${input.slot}, ${input.bookedBy},
                ${input.priceWei.toString()}::numeric, ${input.reservationId})
        returning id, parcel_id, slot
      `
      const row = rows[0]
      if (!row) throw new WorldError('not_booked', 'the booking did not land')
      emit({
        topic: VENUE_BOOKED,
        // ═══════════════════════════════════════════════════════════════════════════════════
        // `keyedBy: 'parcel_id'` — THE PARCEL, NOT THE BOOKING.
        //
        // §11.2 argues this one at length because `booking_id` is the obvious answer and the
        // wrong one: "The contended resource is the parcel's calendar; keying by booking would
        // let two bookings for one slot be processed in either order, which is precisely the
        // failure `keyedBy` exists to prevent."
        //
        // The database already refuses the double-book. Consumers have no such index, and a
        // calendar rendered from these events in booking-id order can show the loser of a race
        // as the winner.
        // ═══════════════════════════════════════════════════════════════════════════════════
        key: row.parcel_id,
        payload: {
          bookingId: row.id,
          parcelId: row.parcel_id,
          slot: row.slot.toISOString(),
          bookedBy: input.bookedBy,
          priceWei: input.priceWei.toString(),
          reservationId: input.reservationId,
        },
        actor: `user:${input.bookedBy.slice('user:'.length)}`,
        correlationId: input.correlationId,
      })
      return { bookingId: row.id }
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('tessera_one_open_booking')) {
      throw new WorldError('slot_taken', 'that slot is already booked', 409)
    }
    if (message.includes('is not a Venue')) {
      throw new WorldError('not_a_venue', message, 409)
    }
    if (message.includes('bookings_slot_is_on_the_hour')) {
      throw new WorldError('slot_not_on_the_hour', 'a booking slot is on the hour', 400)
    }
    if (message.includes('bookings_open_holds_money')) {
      throw new WorldError('no_hold', 'an open booking must hold an escrowed reservation', 400)
    }
    throw err
  }
}

/* ------------------------------------------------------------------------ engagement grants */

export type GrantKind =
  | 'firing_allowance'
  | 'commission'
  | 'listing_fee_subsidy'
  | 'first_listing_bounty'

export interface GrantInput {
  readonly kind: GrantKind
  readonly beneficiary: string
  readonly amountWei: bigint
  /** The ledger entry that ALREADY happened. This row cannot be written before it. */
  readonly ledgerEntryId: string
  readonly idempotencyKey: string
}

/**
 * Record a grant that the ledger has already posted.
 *
 * The signature is the ordering rule: `ledgerEntryId` is required, so there is no way to call this
 * before posting. If the ledger refused — because `engagement:tessera` is empty and `equity` does
 * not get an overdraft — the caller never reaches this function at all, which is the point. See
 * `ledgerclient.ts:grantFromEngagement` for the posting, and `economy.test.ts` for the test that
 * empties the account and watches the refusal come back from a real ledger.
 */
export async function recordGrant(sql: Db, input: GrantInput): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    insert into engagement_grants (kind, beneficiary, amount_wei, ledger_entry_id, idempotency_key)
    values (${input.kind}, ${input.beneficiary}, ${input.amountWei.toString()}::numeric,
            ${input.ledgerEntryId}, ${input.idempotencyKey})
    on conflict (idempotency_key) do update set idempotency_key = excluded.idempotency_key
    returning id
  `
  const row = rows[0]
  if (!row) throw new WorldError('not_recorded', 'the grant did not record')
  return { id: row.id }
}
