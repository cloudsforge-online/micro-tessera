/**
 * The economy, and §12's test 4 — six refusals, each asserted as an ABSENCE with force.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * "No SKU grants discovery ranking, a vote, safety, land, object-cap headroom, or a fee or royalty
 * discount. Six absences, each a test. And the converse: every SKU in §7.3 resolves to a
 * deliverable entitlement or billing product, or the suite fails."
 *
 * An absence is the hardest kind of test to write honestly, because the null implementation passes
 * it. So each one below is written the way `admin-web` asserts its missing og card: it names the
 * mechanism through which the thing WOULD be granted, and asserts that mechanism cannot express
 * it — rather than asserting that a string does not appear somewhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import type postgres from 'postgres'
import {
  ALICE_SUBJECT,
  BOB_SUBJECT,
  asDb,
  enabled,
  migrateTestDb,
  openDb,
  resetTessera,
  seedAccounts,
  seedObject,
  seedWard,
  skip,
  stripComments,
} from './testsupport.ts'
import {
  ENGAGEMENT_ACCOUNT,
  GRANT_ENTRY_KIND,
  bookVenue,
  draftListing,
  platformTerms,
} from './economy.ts'
import {
  ENGAGEMENT_REF,
  ENGAGEMENT_SUBJECT,
  grantPostings,
  holder,
  objectHolder,
  reservePostings,
  balanceCheck,
} from './ledgerclient.ts'
import { entitlementKindFor } from './inbound.ts'
import { fromSparks } from './sparks.ts'
import { WorldError } from './world.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})
after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})
beforeEach(async () => {
  if (!enabled) return
  await resetTessera(sql)
})

/* --------------------------------------------------- the six refusals, as absences */

/**
 * Refusal 1 — DISCOVERY. §7.1: "no promoted placement, no paid ranking, no sponsored beacons, no
 * boost. The feed is ordered by footfall, dwell and recency, and by nothing else, forever."
 *
 * The mechanism through which a SKU becomes a capability in this service is
 * `entitlements.kind`, a CHECK-constrained closed set, reached only via `entitlementKindFor`. So
 * the absence is checked at BOTH ends: no SKU name maps to it, and the database cannot store it.
 */
test('refusal 1: no SKU grants discovery ranking, and the column could not hold it', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of [
    'tessera.boost.featured',
    'tessera.discovery.promoted',
    'tessera.ranking.boost',
    'tessera.beacon.sponsored',
    'tessera.feed.pinned',
  ]) {
    assert.equal(entitlementKindFor(sku), null, `${sku} maps to an entitlement kind`)
  }
  for (const kind of ['discovery', 'ranking', 'boost', 'promotion', 'featured']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
      `the entitlements table accepted kind='${kind}' — discovery is not for sale, ever`,
    )
  }
})

/** Refusal 2 — VOTES. Governance is `micro-community`, one member one vote, and Tessera must never
 *  wire a token-weighted resolver. There is no weight anywhere in this service to wire one to. */
test('refusal 2: no SKU grants a vote, and this service holds no vote weight at all', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.vote.weighted', 'tessera.governance.seat']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['vote_weight', 'vote', 'governance']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
  // And no column in this schema stores a weight, so there is nothing for a resolver to read.
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public' and (column_name like '%weight%' or column_name like '%vote%')
  `
  // `.length`, not `deepEqual([], …)`: postgres.js returns an array-like carrying `count` and
  // `command`, so a deep-equal against a bare array fails even when there are no rows — which
  // would have made this test red for a reason that has nothing to do with vote weights, and
  // would have been "fixed" by weakening it.
  assert.equal(
    columns.length,
    0,
    `a vote weight column exists — §7.1 refusal 2: ${columns.map((c) => `${c.table_name}.${c.column_name}`).join(', ')}`,
  )
})

/** Refusal 3 — SAFETY. "A safety feature behind a paywall is a protection racket with a price list." */
test('refusal 3: no SKU grants safety, privacy or moderation', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.safety.premium', 'tessera.privacy.enhanced', 'tessera.moderation.priority']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['safety', 'privacy', 'moderation', 'ban_immunity']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
})

/** Refusal 4 — LAND. The platform never sells it. There is no `land` entitlement, and `claimParcel`
 *  cannot reach money at all — asserted separately in `world.test.ts`. */
test('refusal 4: no SKU grants land, at any tier, ever', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.land.plot', 'tessera.parcel.premium', 'tessera.ward.quarter']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  for (const kind of ['land', 'parcel', 'ground']) {
    await assert.rejects(
      () => sql`insert into entitlements (subject, kind, sku, entitlement_id)
                values (${ALICE_SUBJECT}, ${kind}, 'x', ${`e-${kind}`})`,
      (err: unknown) => String(err).includes('entitlements_kind_known'),
    )
  }
})

/**
 * Refusal 5 — OBJECT-CAP HEADROOM. §6.2: "it is a rendering budget, it is stated as one, and it is
 * not purchasable at any price."
 *
 * The strongest possible form: `object_cap` is a GENERATED column, so there is no UPDATE that can
 * raise it. Not "no route does"; no STATEMENT does. `world.test.ts` proves the write is refused;
 * this proves no SKU could ask for it either.
 */
test('refusal 5: no SKU grants object-cap headroom, and the column is not writable', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  for (const sku of ['tessera.objects.more', 'tessera.cap.raise', 'tessera.prims.extra']) {
    assert.equal(entitlementKindFor(sku), null)
  }
  const generated = await sql<{ is_generated: string }[]>`
    select is_generated from information_schema.columns
     where table_name = 'parcels' and column_name = 'object_cap'
  `
  assert.equal(generated[0]?.is_generated, 'ALWAYS', 'object_cap stopped being generated')
})

/**
 * Refusal 6 — A FEE OR ROYALTY DISCOUNT. §7.2's fifth refusal, which is the condition the whole
 * no-pay-to-win argument rests on: "A subscription that cut your marketplace fee would convert
 * money directly into structural earning advantage over every creator who did not buy it."
 *
 * Three ways it is impossible: no SKU maps to it; `platformTerms` takes no subject, so there is no
 * per-account rate to return; and the trigger refuses a listing whose fee differs from the one row.
 */
test('refusal 6: no fee or royalty discount, and the rate is the same for every account', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  for (const sku of ['tessera.fee.discount', 'tessera.pro.subscription', 'tessera.royalty.reduced']) {
    assert.equal(entitlementKindFor(sku), null)
  }

  // `platformTerms(sql)` — ONE argument. A per-account rate would need a parameter here before it
  // needed a column anywhere, so the arity IS the refusal.
  assert.equal(platformTerms.length, 1, 'platformTerms takes a second argument — a per-account rate')

  const terms = await platformTerms(asDb(sql))
  assert.equal(terms.platformFeeBps, 250)
  assert.equal(terms.maxRoyaltyBps, 1_000)

  const object = await seedObject(sql, ALICE_SUBJECT)
  // A listing that took a cheaper fee is refused by the trigger, whatever wrote it.
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 500, 100)`,
    (err: unknown) => String(err).includes('the rate is identical for every account'),
  )
  // And a royalty above the cap.
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 1001, 250)`,
    (err: unknown) => String(err).includes('the cap is identical for every account'),
  )
  // Two sellers, two listings, one rate.
  const listingA = await draftListing(asDb(sql), {
    objectId: object,
    sellerSubject: ALICE_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  const objectB = await seedObject(sql, BOB_SUBJECT, 2)
  const listingB = await draftListing(asDb(sql), {
    objectId: objectB,
    sellerSubject: BOB_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  assert.equal(listingA.platformFeeBps, listingB.platformFeeBps)
})

/**
 * The CONVERSE §12 asks for: "every SKU in §7.3 resolves to a deliverable entitlement or billing
 * product, or the suite fails."
 *
 * Principle 3 of `01-product-vision.md`. A SKU that is sold and cannot be delivered is worse than
 * one that does not exist.
 */
test('every SKU in §7.3 resolves to a deliverable entitlement kind', () => {
  const skus: ReadonlyArray<readonly [string, string]> = [
    ['tessera.kiln.pack10', 'kiln_capacity'],
    ['tessera.deed.slot', 'deed_slots'],
    ['tessera.appearance.gouache', 'appearance'],
    ['tessera.name.reserve', 'name_reservation'],
    // Already exists in billing/src/migrations.ts:405 and no title serves it today.
    ['world.private.small', 'private_ward'],
    ['tessera.venue.calendar', 'venue_calendar'],
  ]
  assert.equal(skus.length, 6, '§7.3 lists six SKUs')
  for (const [sku, kind] of skus) {
    assert.equal(entitlementKindFor(sku), kind, `${sku} does not resolve to a deliverable kind`)
  }
})

/* ------------------------------------------------------- the ledger, and the empty reserve */

test('the engagement account is engagement:tessera / EMBER / treasury, typed equity', () => {
  // The spelling comes from the contract, and the TYPE is the safety property:
  // `ledger_assert_no_overdraft` exempts clearing and suspense, not equity. A second spelling
  // silently splits the programme's ledger in half — the defect foresight shipped.
  assert.equal(ENGAGEMENT_ACCOUNT.subject, 'engagement:tessera')
  assert.equal(ENGAGEMENT_ACCOUNT.assetCode, 'EMBER')
  assert.equal(ENGAGEMENT_ACCOUNT.purpose, 'treasury')
  assert.equal(ENGAGEMENT_REF.type, 'equity')
  assert.equal(GRANT_ENTRY_KIND, 'treasury_spend')

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // AND `ENGAGEMENT_REF` IS STILL FIELD-FOR-FIELD THE CONTRACT'S ACCOUNT.
  //
  // It used to be three property reads off `ENGAGEMENT_ACCOUNT`, which made drift impossible by
  // construction and made the account unreadable to micro-conformance's `ledger-accounts` sweep —
  // the check that reconciles the type every service claims per key, and the only thing in the
  // estate that would catch a second service typing `engagement:tessera` differently. It is now
  // written out so the sweep can compare it. THIS is what replaces the derivation: if anyone
  // changes the contract's `engagementAccount`, or retypes this literal, these four fail.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(ENGAGEMENT_REF.subject, ENGAGEMENT_ACCOUNT.subject)
  assert.equal(ENGAGEMENT_REF.assetCode, ENGAGEMENT_ACCOUNT.assetCode)
  assert.equal(ENGAGEMENT_REF.purpose, ENGAGEMENT_ACCOUNT.purpose)
  assert.equal(ENGAGEMENT_SUBJECT, ENGAGEMENT_ACCOUNT.subject)
})

/**
 * The refusal that replaced a silent pass-through.
 *
 * `holder` used to canonicalise a `user:` subject and return anything else UNCHANGED, so
 * `holder('alice', …)` produced an account keyed on the subject `alice` — not a user account, not
 * any kind `AccountSubject` names, and reconcilable with nothing. Tessera's `accounts` table
 * admits no such subject (`accounts_subject_is_a_user`, migrations.ts:203) and every subject
 * column is a foreign key into it, so this path was already unreachable from the database; the
 * throw is that guarantee said out loud rather than assumed.
 */
test('an account subject that is not a user is refused, not passed through', () => {
  assert.throws(() => holder('alice', 'available'), /not a user subject/)
  assert.throws(() => holder('platform', 'available'), /not a user subject/)
  assert.throws(() => objectHolder('community:x', 'TOKEN:cf:tessera:object:ff'), /not a user subject/)
  // The legitimate one still works, and still comes out spelled by the contract.
  assert.equal(holder(ALICE_SUBJECT, 'available').subject, ALICE_SUBJECT)
  assert.equal(holder(ALICE_SUBJECT, 'reserved').purpose, 'reserved')
})

test('a grant debits the engagement account and balances, and the postings are the wire shape', () => {
  const postings = grantPostings(ALICE_SUBJECT, fromSparks(400n))
  assert.equal(postings.length, 2)
  const debit = postings.find((p) => p.direction === 'debit')
  assert.equal(debit?.account.subject, 'engagement:tessera')
  // equity, so an unfunded grant is refused at the DATABASE rather than by a handler that forgot
  // to look. This is the whole of "chain-backed by construction", in one field.
  assert.equal(debit?.account.type, 'equity')
  const credit = postings.find((p) => p.direction === 'credit')
  assert.equal(credit?.account.subject, ALICE_SUBJECT)
  assert.equal(credit?.account.purpose, 'available')
  assert.equal(credit?.account.type, 'liability')
  // Balanced before the socket opens — this throws if it is not.
  balanceCheck(postings)
})

/**
 * §8.2, asserted about the WHOLE REPOSITORY rather than about one call site.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS TEST USED TO REQUIRE EXACTLY ONE `payout_due` DEBIT. IT NOW REQUIRES NONE, AND THAT IS A
 * CORRECTION RATHER THAN A RELAXATION.**
 *
 * The one debit it allowed was `releasePostings`, which had zero callers. Reading micro-market's
 * source rather than the design prose showed why it should never gain one:
 *
 *   * market credits the SELLER's `payout_due` at settlement (`market/src/orders.ts:339`, `:388`),
 *     and
 *   * market RELEASES it to `available` when the dispute window has run — `releaseProceeds`
 *     (`orders.ts:696`) driven by a leased job (`market/src/jobs.ts:322`, `PAYOUT_KIND`).
 *
 * So a Tessera release would be a second service moving one payout. The ledger would refuse it —
 * a user's `payout_due` is `liability`, which `ledger_assert_no_overdraft` does not exempt — but
 * "the database catches it" is not a reason to keep code whose only correct number of calls is
 * zero. Tessera's money is engagement grants and booking reservations; sale proceeds are market's.
 *
 * Written as a scan over every source file because "Tessera never releases a payout" is a claim
 * about the repository, and no single call site can make it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('Tessera never debits payout_due — releasing a creator\'s proceeds is micro-market\'s job', () => {
  const dir = new URL('.', import.meta.url)
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  assert.ok(files.length > 8, 'no sources were scanned; this check is grading nothing')
  const sites: string[] = []
  for (const file of files) {
    const source = stripComments(readFileSync(new URL(file, dir), 'utf8'))
    // A debit against payout_due looks like `holder(x, PAYOUT_DUE), direction: 'debit'`.
    const pattern = /PAYOUT_DUE\s*\)\s*,\s*direction:\s*'debit'/g
    for (const _ of source.matchAll(pattern)) sites.push(file)
  }
  assert.deepEqual(sites, [], 'Tessera debits payout_due somewhere — that is micro-market paying twice')

  // And the function itself is gone, not merely uncalled. An exported `releasePayout` with no
  // callers is an invitation; the absence is the guard.
  const ledgerSource = stripComments(
    readFileSync(new URL('./ledgerclient.ts', import.meta.url), 'utf8'),
  )
  assert.ok(!/export\s+(async\s+)?function\s+releasePayout\b/.test(ledgerSource))
  assert.ok(!/export\s+function\s+releasePostings\b/.test(ledgerSource))
})

test('a reservation is a posting from available to reserved — two accounts, not two columns', () => {
  const postings = reservePostings(ALICE_SUBJECT, 500n)
  assert.equal(postings[0]?.account.purpose, 'available')
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[1]?.account.purpose, 'reserved')
  assert.equal(postings[1]?.direction, 'credit')
  balanceCheck(postings)
})

/* ------------------------------------------------------------------ listings and bookings */

test('a Tessera listing is always custodial, because that is the only mode with a royalty', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps, settlement_mode)
              values (${object}, ${ALICE_SUBJECT}, ${fromSparks(400n).toString()}::numeric, 500, 250, 'onchain')`,
    (err: unknown) => String(err).includes('tessera_listings_are_custodial'),
  )
  const listing = await draftListing(asDb(sql), {
    objectId: object,
    sellerSubject: ALICE_SUBJECT,
    priceWei: fromSparks(400n),
    royaltyBps: 500,
    correlationId: 'r',
  })
  assert.equal(listing.settlementMode, 'custodial')
  // And the split the seller is shown partitions the price exactly.
  assert.equal(
    listing.split.feeWei + listing.split.royaltyWei + listing.split.proceedsWei,
    listing.priceWei,
  )
})

test('a price finer than one Spark is refused by the CHECK and by the handler', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into listings (object_id, seller_subject, price_wei, royalty_bps, platform_fee_bps)
              values (${object}, ${ALICE_SUBJECT}, 400000000001, 500, 250)`,
    (err: unknown) => String(err).includes('tessera_price_whole_sparks'),
  )
  await assert.rejects(
    () =>
      draftListing(asDb(sql), {
        objectId: object,
        sellerSubject: ALICE_SUBJECT,
        priceWei: 400_000_000_001n,
        royaltyBps: 500,
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'price_not_whole_sparks',
  )
})

test('a venue booking needs a venue, an escrow hold, and an unbooked slot', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32) returning id
  `
  const parcelId = rows[0]!.id
  const slot = new Date('2027-01-01T18:00:00.000Z')

  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot,
        bookedBy: BOB_SUBJECT,
        priceWei: fromSparks(5_000n),
        reservationId: 'res-1',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'not_a_venue',
  )

  await sql`update parcels set is_venue = true where id = ${parcelId}`
  const booked = await bookVenue(asDb(sql), {
    parcelId,
    slot,
    bookedBy: BOB_SUBJECT,
    priceWei: fromSparks(5_000n),
    reservationId: 'res-1',
    correlationId: 'r',
  })
  assert.ok(booked.bookingId)

  // The same slot again is refused.
  await assert.rejects(
    () =>
      bookVenue(asDb(sql), {
        parcelId,
        slot,
        bookedBy: ALICE_SUBJECT,
        priceWei: fromSparks(5_000n),
        reservationId: 'res-2',
        correlationId: 'r',
      }),
    (err: unknown) => err instanceof WorldError && err.code === 'slot_taken',
  )

  // A free hold is unrepresentable, so nobody can squat a calendar for nothing.
  await assert.rejects(
    () => sql`insert into bookings (parcel_id, slot, booked_by, price_wei)
              values (${parcelId}, ${new Date('2027-01-02T18:00:00.000Z')}, ${BOB_SUBJECT}, 0)`,
    (err: unknown) => String(err).includes('bookings_open_holds_money'),
  )

  // And the event is keyed by the PARCEL, not the booking. §11.2.
  const events = await sql<{ key: string; payload: Record<string, unknown> }[]>`
    select key, payload from outbox where topic = 'tessera.venue.booked'
  `
  assert.equal(events.length, 1)
  assert.equal(events[0]?.key, parcelId)
  assert.notEqual(events[0]?.key, booked.bookingId)

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE PAYLOAD NAMES THE OWNER, AND THAT IS THE ONLY REASON A NOTIFY RULE CAN EXIST.
  //
  // `notify/src/topics.ts:308` records this topic `blockedBy: 'no-subject'`. The payload named
  // the BOOKER, so the party whose venue was taken and whose money is on the other end of
  // `reservationId` was absent — a rule on it answers `no_recipient` for ever, or tells Bob about
  // Bob's own booking.
  //
  // Asserted as a DIFFERENCE, not just presence: Alice owns, Bob books, and a payload that
  // derived the owner from the actor would pass a `typeof === 'string'` check and be wrong.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  assert.equal(events[0]?.payload['ownerSubject'], ALICE_SUBJECT)
  assert.equal(events[0]?.payload['bookedBy'], BOB_SUBJECT)
  assert.notEqual(
    events[0]?.payload['ownerSubject'],
    events[0]?.payload['bookedBy'],
    'the owner was derived from the actor rather than read from the parcel',
  )
  assert.equal(events[0]?.payload['wardId'], ward)
})

test('an engagement grant cannot be recorded without naming its ledger entry', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into engagement_grants (kind, beneficiary, amount_wei, idempotency_key)
              values ('commission', ${ALICE_SUBJECT}, ${fromSparks(100n).toString()}::numeric, 'k1')`,
    (err: unknown) => String(err).includes('ledger_entry_id') || String(err).includes('not-null'),
    'a grant was recorded with no ledger entry behind it — doc 21 §7.4',
  )
})
