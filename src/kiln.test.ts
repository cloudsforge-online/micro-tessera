/**
 * The Kiln: content addressing, the two facings, and the object cap at commit.
 */

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
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
} from './testsupport.ts'
import {
  CATEGORIES,
  FACINGS,
  FOOTPRINTS,
  OBJECT_CANVAS,
  completeFiring,
  findObject,
  firingLeaseKey,
  listPlacements,
  placeObjects,
  removePlacement,
  requestFiring,
} from './kiln.ts'
import { WorldError } from './world.ts'
import { promptFor } from './studioclient.ts'

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

/* ---------------------------------------------------------------------------- pure */

test('twelve categories, two footprints, two facings — §6.3, as the closed sets they are', () => {
  assert.equal(CATEGORIES.length, 12)
  assert.deepEqual([...FOOTPRINTS], ['1x1', '2x2'])
  // TWO facings, because micro-studio has no seed column and a pipeline that cannot fix a seed
  // cannot render the same chair four times. §2.1. The day studio stores a seed this becomes
  // four, and this assertion is where the change is noticed.
  assert.deepEqual([...FACINGS], ['canonical', 'mirrored'])
  // §6.3's combinatorics, checkable: 4 builds x 8^5 overlays = 131,072 avatars from 48 assets.
  assert.equal(4 * 8 ** 5, 131_072)
})

test('the canvas is 512 and is a multiple of 16, which is what FLUX floors to', () => {
  assert.equal(OBJECT_CANVAS, 512)
  assert.equal(OBJECT_CANVAS % 16, 0)
})

test('the prompt fixes the projection, the light and the ground — a user cannot override the brief', () => {
  const prompt = promptFor('a three-legged stool')
  assert.match(prompt, /a three-legged stool/)
  assert.match(prompt, /2:1 dimetric/)
  assert.match(prompt, /#12100f/)
  assert.match(prompt, /painterly gouache/)
  // No outlines, no bevels, no gloss — §1.1's direction, which is what makes one player's chair
  // sit in the same world as another player's chair.
  assert.match(prompt, /no outline/)
  assert.match(prompt, /no bevel/)
  assert.match(prompt, /no gloss/)
})

test('the firing lease key is the shape studio uses, so one players firings serialise on both sides', () => {
  // studio/src/generation.ts:234 — `owner:<subject>`. §11.4 says the match is deliberate.
  assert.equal(firingLeaseKey(ALICE_SUBJECT), `owner:${ALICE_SUBJECT}`)
  assert.match(firingLeaseKey(ALICE_SUBJECT), /^owner:/)
})

/* ------------------------------------------------------------------- against Postgres */

test('the same bytes fired twice resolve to the ORIGINAL author — copybot, answered', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const alices = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: 'a stool',
    category: 'seating',
    footprint: '1x1',
    correlationId: 'r1',
  })
  const checksum = `sha256:${'ab'.repeat(32)}`
  await completeFiring(asDb(sql), {
    objectId: alices.id,
    checksum,
    studioAssetId: 'asset-1',
    c2pa: true,
    correlationId: 'r1',
  })

  // Bob fires and — impossibly but instructively — gets identical bytes back.
  const bobs = await requestFiring(asDb(sql), {
    authorSubject: BOB_SUBJECT,
    prompt: 'a stool',
    category: 'seating',
    footprint: '1x1',
    correlationId: 'r2',
  })
  const resolved = await completeFiring(asDb(sql), {
    objectId: bobs.id,
    checksum,
    studioAssetId: 'asset-2',
    c2pa: true,
    correlationId: 'r2',
  })

  // It resolves to Alice's object and Alice's authorship. It does NOT raise — an honest
  // coincidence is not an error — and it does NOT create a second owner, which is the whole point.
  assert.equal(resolved.id, alices.id)
  assert.equal(resolved.authorSubject, ALICE_SUBJECT)

  // Bob's firing is recorded as failed, with a reason that names the object and its author.
  const bobsRow = await findObject(asDb(sql), bobs.id)
  assert.equal(bobsRow?.status, 'failed')
  const reason = await sql<{ failure_reason: string }[]>`
    select failure_reason from objects where id = ${bobs.id}
  `
  assert.match(String(reason[0]?.failure_reason), /already object/)
  assert.match(String(reason[0]?.failure_reason), new RegExp(ALICE_SUBJECT))

  // And there is exactly one object with those bytes, whatever any handler did.
  const count = await sql<{ n: number }[]>`
    select count(*)::int as n from objects where checksum = ${checksum}
  `
  assert.equal(count[0]?.n, 1)

  // ═══════════════════════════════════════════════════════════════════════════════════════
  // THE ASSERTIONS ABOVE GRADE THE HANDLER. THESE GRADE THE DATABASE, AND THEY WERE ADDED
  // BECAUSE A MUTATION SWEEP SHOWED THE DIFFERENCE.
  //
  // Dropping `tessera_objects_are_their_bytes` and re-running this file left it GREEN. Everything
  // above still passed, because `completeFiring` does a SELECT and branches — so with the index
  // gone it still returns the original object and still writes one row. The test was measuring an
  // `if`, which is precisely the estate's "four tests passing while grading the wrong function".
  //
  // The `if` is the sentence a user reads. The INDEX is the guarantee, and it is the only half
  // that survives a concurrent firing, a backfill or a psql prompt — a SELECT-then-INSERT is a
  // race, and without a unique index two firings that resolve the same bytes at the same instant
  // both pass the check and both insert. So the index is asked directly.
  // ═══════════════════════════════════════════════════════════════════════════════════════
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${BOB_SUBJECT}, 'a stool', 'seating', '1x1', 'fired', ${checksum})`,
    (err: unknown) => String(err).includes('tessera_objects_are_their_bytes'),
    'a raw INSERT created a second object at one content address — ownership is not derived after all',
  )

  // And genuinely concurrently, on two connections, which is the shape the handler cannot defend
  // against on its own.
  const a = openDb(2)
  const b = openDb(2)
  const racing = `sha256:${'99'.repeat(32)}`
  try {
    const results = await Promise.allSettled([
      a`insert into objects (author_subject, prompt, category, footprint, status, checksum)
        values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${racing})`,
      b`insert into objects (author_subject, prompt, category, footprint, status, checksum)
        values (${BOB_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${racing})`,
    ])
    assert.equal(
      results.filter((r) => r.status === 'fulfilled').length,
      1,
      'two authors landed at one content address',
    )
  } finally {
    await a.end({ timeout: 5 })
    await b.end({ timeout: 5 })
  }
})

test('there is no owner column on objects, and authorship cannot be re-pointed', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)

  // The forgeable field the reference had simply does not exist.
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns where table_name = 'objects'
  `
  const names = columns.map((c) => c.column_name)
  assert.equal(names.includes('owner_subject'), false, 'objects has an owner column — §9.2 says ownership is derived')
  assert.ok(names.includes('author_subject'))

  await assert.rejects(
    () => sql`update objects set author_subject = ${BOB_SUBJECT} where id = ${id}`,
    (err: unknown) => String(err).includes('authorship is a fact about the file'),
  )
  await assert.rejects(
    () => sql`update objects set checksum = ${`sha256:${'cd'.repeat(32)}`} where id = ${id}`,
    (err: unknown) => String(err).includes('addressed by its bytes'),
  )
})

test('a fired object without bytes, and a checksum of the wrong shape, are both refused', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired')`,
    (err: unknown) => String(err).includes('objects_fired_have_bytes'),
  )
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', 'deadbeef')`,
    (err: unknown) => String(err).includes('objects_checksum_shape'),
  )
  // Uppercase hex is a second spelling of one address, so it is refused rather than normalised.
  await assert.rejects(
    () => sql`insert into objects (author_subject, prompt, category, footprint, status, checksum)
              values (${ALICE_SUBJECT}, 'x', 'seating', '1x1', 'fired', ${`sha256:${'AB'.repeat(32)}`})`,
    (err: unknown) => String(err).includes('objects_checksum_shape'),
  )
})

test('half an anchor is unrepresentable — a claim the chain does not back cannot be written', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const id = await seedObject(sql, ALICE_SUBJECT)
  await assert.rejects(
    () => sql`update objects set anchor_tx = '0xabc' where id = ${id}`,
    (err: unknown) => String(err).includes('objects_anchor_is_whole'),
  )
  await assert.rejects(
    () => sql`update objects set anchor_block = 1, anchored_at = now() where id = ${id}`,
    (err: unknown) => String(err).includes('objects_anchor_is_whole'),
  )
  await sql`update objects set anchor_tx = '0xabc', anchor_block = 1, anchored_at = now() where id = ${id}`
})

test('a third facing is refused — two, and the reason is a missing column in studio', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const parcel = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id
  `
  await assert.rejects(
    () => sql`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
              values (${parcel[0]!.id}, ${object}, 0, 0, 'north', ${ALICE_SUBJECT})`,
    (err: unknown) => String(err).includes('placements_facing_is_one_of_two'),
  )
})

/**
 * §12's test 6, exactly as written: "including via a bulk paste that is individually under the cap
 * and collectively over it."
 */
test('the object cap is checked at COMMIT, so a bulk paste is one check and not two hundred', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string; object_cap: number }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'homestead', 0, 0, 16) returning id, object_cap
  `
  const parcel = rows[0]!
  assert.equal(parcel.object_cap, 160)

  const paste = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      parcelId: parcel.id,
      objectId: object,
      x: i % 16,
      y: Math.floor(i / 16) % 16,
      facing: 'canonical' as const,
      placedBy: ALICE_SUBJECT,
    }))

  // Exactly at the cap is fine.
  await placeObjects(asDb(sql), paste(160))
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160)

  // One more, in its own transaction, is refused.
  await assert.rejects(
    () => placeObjects(asDb(sql), paste(1)),
    (err: unknown) => err instanceof WorldError && err.code === 'over_object_cap',
  )
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160, 'the failed paste left rows behind')

  // And the bulk shape §12 names: from empty, 161 rows each individually under the cap, refused as
  // a whole at COMMIT.
  await sql`delete from placements where parcel_id = ${parcel.id}`
  await assert.rejects(
    () => placeObjects(asDb(sql), paste(161)),
    (err: unknown) => err instanceof WorldError && err.code === 'over_object_cap',
  )
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 0)

  // A transaction that goes OVER and comes back under commits — which an immediate per-row check
  // would have refused, and which is the reason for deferring.
  await sql.begin(async (tx) => {
    for (const p of paste(161)) {
      await tx`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
               values (${p.parcelId}, ${p.objectId}, ${p.x}, ${p.y}, ${p.facing}, ${p.placedBy})`
    }
    await tx`delete from placements where parcel_id = ${parcel.id} and ctid in (
               select ctid from placements where parcel_id = ${parcel.id} limit 1)`
  })
  assert.equal((await listPlacements(asDb(sql), parcel.id)).length, 160)
})

test('placing and removing an object resets the fallow clock, whoever does it', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const rows = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size, claimed_at)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32, now() - interval '100 days') returning id
  `
  const parcelId = rows[0]!.id

  const before = await sql<{ last_edit_at: Date | null }[]>`
    select last_edit_at from parcels where id = ${parcelId}
  `
  assert.equal(before[0]?.last_edit_at, null)

  // A RAW insert, no handler — the trigger is what makes this true for every path.
  await sql`insert into placements (parcel_id, object_id, x, y, facing, placed_by)
            values (${parcelId}, ${object}, 0, 0, 'canonical', ${ALICE_SUBJECT})`
  const after = await sql<{ last_edit_at: Date | null }[]>`
    select last_edit_at from parcels where id = ${parcelId}
  `
  assert.notEqual(after[0]?.last_edit_at, null)

  // And the parcel is no longer fallow, because an edit IS activity.
  const fallow = await sql<{ n: number }[]>`
    select count(*)::int as n from parcels
     where status = 'held' and tier <> 'homestead'
       and now() >= tessera_fallow_at(last_active_at, banked_until)
  `
  assert.equal(fallow[0]?.n, 0)
})

test('a placement can only be removed by the parcels owner', { skip }, async () => {
  const ward = await seedWard(sql)
  await seedAccounts(sql, ALICE_SUBJECT, BOB_SUBJECT)
  const object = await seedObject(sql, ALICE_SUBJECT)
  const parcel = await sql<{ id: string }[]>`
    insert into parcels (ward_id, owner_subject, tier, origin_x, origin_y, size)
    values (${ward}, ${ALICE_SUBJECT}, 'plot', 0, 0, 32) returning id
  `
  await placeObjects(asDb(sql), [
    { parcelId: parcel[0]!.id, objectId: object, x: 0, y: 0, facing: 'canonical', placedBy: ALICE_SUBJECT },
  ])
  const placements = await listPlacements(asDb(sql), parcel[0]!.id)
  await assert.rejects(
    () => removePlacement(asDb(sql), placements[0]!.id, BOB_SUBJECT),
    (err: unknown) => err instanceof WorldError && err.status === 404,
  )
  await removePlacement(asDb(sql), placements[0]!.id, ALICE_SUBJECT)
  assert.equal((await listPlacements(asDb(sql), parcel[0]!.id)).length, 0)
})

test('a firing emits tessera.object.fired keyed by the object, carrying the MEASURED c2pa', { skip }, async () => {
  await seedAccounts(sql, ALICE_SUBJECT)
  const object = await requestFiring(asDb(sql), {
    authorSubject: ALICE_SUBJECT,
    prompt: 'a lantern',
    category: 'lighting',
    footprint: '1x1',
    correlationId: 'req-k',
  })
  await completeFiring(asDb(sql), {
    objectId: object.id,
    checksum: `sha256:${'ef'.repeat(32)}`,
    studioAssetId: 'a-1',
    // Studio measured FALSE. It must arrive as false, not be defaulted to true anywhere —
    // §2.2: "a repo that asserts it is a repo that will be wrong quietly".
    c2pa: false,
    correlationId: 'req-k',
  })
  const rows = await sql<{ topic: string; key: string; payload: Record<string, unknown> }[]>`
    select topic, key, payload from outbox where topic = 'tessera.object.fired'
  `
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.key, object.id)
  assert.equal(rows[0]?.payload['c2pa'], false)
  assert.equal(rows[0]?.payload['authorSubject'], ALICE_SUBJECT)
})
