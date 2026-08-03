/**
 * Every `studio/src/…:N` claim this repository makes, resolved against micro-studio's real source.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS: THE SAME CITATIONS HAVE NOW ROTTED TWICE.
 *
 * `micro-studio` landed a writability probe and a route validation. Neither changed anything this
 * service does — the Kiln refuses an empty description client-side, so it never meets studio's new
 * 400 — but both INSERTED LINES, and eleven `path:line` citations in this repository silently came
 * to point at the wrong thing. A citation that points at the wrong line is worse than none: it
 * reads as evidence and is not, and the next person to check it "verifies" a claim against
 * whatever now sits at that number.
 *
 * Correcting eleven numbers by hand fixes today and guarantees a third recurrence. So the numbers
 * in this repository's prose are now CHECKED against the bytes of the sibling repository. When
 * studio moves a line, this file goes red and names both the anchor and the number to write —
 * which is the moment the prose becomes wrong, rather than the moment somebody notices.
 *
 * ── The two ways a content pin lies, and why neither is available here ────────────────────────
 *
 * `@cloudsforge/ui/cite` requires an anchor to match EXACTLY ONE line: zero throws, and two throws
 * and names both. So an anchor cannot quietly match nothing while reading as verified, and cannot
 * drift onto a line it does not mean. That rule is why `readonly c2pa: boolean` is NOT pinned
 * directly — it occurs three times in `assets.ts`, and a field line is unpinnable in principle
 * because any field added above it moves it. The prose now cites the `Asset` INTERFACE, which is
 * the durable thing it always meant, and the pin asserts the field sits inside it.
 *
 * ── A missing sibling is a SKIP, and never a `return` ─────────────────────────────────────────
 *
 * `micro-studio` may not be checked out. `t.skip()` marks the test skipped in the runner's summary;
 * `return` marks it GREEN. Six tests in this estate returned early and reported passes for work
 * they never did, and `testsupport.ts` opens with the same warning about database preconditions.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { block, cite, type Anchor } from '@cloudsforge/ui/cite'

const REPO = dirname(fileURLToPath(import.meta.url))
const STUDIO = resolve(REPO, '..', '..', 'studio', 'src')

interface Pin {
  /** The file under `studio/src/`. */
  readonly file: string
  /** Must match exactly one line of it. */
  readonly anchor: Anchor
  /** The line number this repository's prose currently claims. */
  readonly line: number
  /** Where the claim is written here, so a failure says which comment to edit. */
  readonly citedBy: string
}

/**
 * Every studio line number asserted in this repository's source.
 *
 * The `citedBy` column is deliberately a file name and not a line number: a line number here would
 * be a citation into THIS repository with exactly the decay problem this file exists to fix.
 */
const PINS: readonly Pin[] = Object.freeze([
  // ── the two routes a firing calls, in order ────────────────────────────────────────────────
  {
    file: 'server.ts',
    anchor: "define('POST', '/v1/brand-kits', ",
    line: 373,
    citedBy: 'studioclient.ts (the route table)',
  },
  {
    file: 'server.ts',
    anchor: "define('POST', '/v1/brand-kits/:id/generate'",
    line: 418,
    citedBy: 'studioclient.ts (the route table), migrations.ts migration 13',
  },
  // The 202 that makes a firing a leased job on both sides.
  { file: 'server.ts', anchor: 'status: 202,', line: 470, citedBy: 'kiln.ts header, studioclient.ts' },
  {
    file: 'server.ts',
    anchor: "define('GET', '/v1/jobs/:id'",
    line: 487,
    citedBy: 'migrations.ts migration 13 (the status shape)',
  },
  // `wireJob` does NOT carry the checksum or the asset id — the reason firing polls `provenance`.
  { file: 'server.ts', anchor: 'function wireJob(', line: 513, citedBy: 'kiln.ts, studioclient.ts, kiln.live.test.ts' },
  // The service lane: name the user without impersonating them.
  { file: 'server.ts', anchor: 'function subjectOf(', line: 548, citedBy: 'kiln.ts header, studioclient.ts' },
  {
    file: 'server.ts',
    anchor: "if (principal.kind === 'service') return",
    line: 576,
    citedBy: 'kiln.ts header, studioclient.ts (assertOwned returns early)',
  },
  // ── the prompt studio builds, which is why this client sends none ──────────────────────────
  { file: 'prompt.ts', anchor: 'export function buildPrompt(', line: 127, citedBy: 'studioclient.ts, kiln.test.ts' },
  {
    file: 'prompt.ts',
    anchor: "if (input.spec.kind === 'world_object' && input.stylePrompt.trim().length === 0)",
    line: 143,
    citedBy: 'jobs.ts, studioclient.ts (the empty-description refusal)',
  },
  { file: 'prompt.ts', anchor: 'The object is: ', line: 151, citedBy: 'studioclient.ts (how the description is wrapped)' },
  // ── the checksum that IS the object's identity ─────────────────────────────────────────────
  {
    file: 'assets.ts',
    anchor: 'export function checksumOf(',
    line: 78,
    citedBy: 'studioclient.ts (sha256:<hex> spelling)',
  },
  { file: 'assets.ts', anchor: 'export interface Asset {', line: 46, citedBy: 'studioclient.ts (c2pa lives on the asset)' },
])

function studioPresent(): boolean {
  return existsSync(join(STUDIO, 'server.ts'))
}

test('every studio line this repository cites is the line it claims', (t: TestContext) => {
  if (!studioPresent()) {
    t.skip(`${STUDIO} is not checked out — these citations cannot be resolved`)
    return
  }
  assert.ok(PINS.length > 0, 'no citations are pinned, so this test asserts nothing')
  for (const pin of PINS) {
    const found = cite(join(STUDIO, pin.file), pin.anchor)
    assert.equal(
      found.line,
      pin.line,
      `studio/src/${pin.file} moved: the anchor is now at :${found.line}, but this repository ` +
        `still says :${pin.line} in ${pin.citedBy}. Update the prose and this pin together.`,
    )
  }
})

/**
 * The claim the `c2pa` pin is actually making. The interface is what is pinned; that the field
 * lives INSIDE it is the thing the prose asserts, and it is checked rather than assumed.
 */
test('c2pa is a field of studio\'s Asset, which is why this service reads null', (t: TestContext) => {
  if (!studioPresent()) {
    t.skip(`${STUDIO} is not checked out — this citation cannot be resolved`)
    return
  }
  const asset = cite(join(STUDIO, 'assets.ts'), 'export interface Asset {')
  // 18 lines: `export interface Asset {` through its closing brace at :63.
  const body = block(asset, 18)
  assert.match(body, /^}/m, 'the Asset interface does not close within 18 lines — the pin is stale')
  assert.match(body, /readonly c2pa: boolean/, 'c2pa is no longer a field of studio\'s Asset')
  // And the converse half of the claim: it is NOT on the job status, which is why `c2pa` arrives
  // null here rather than false. `wireJob` is the shape `GET /v1/jobs/:id` answers with.
  const wire = cite(join(STUDIO, 'server.ts'), 'function wireJob(')
  assert.doesNotMatch(
    block(wire, 21),
    /c2pa/,
    'wireJob now carries c2pa — studioclient.ts says it cannot, and should start reading it',
  )
})

/**
 * The citations inside `migrations.ts` are DELIBERATELY not corrected, and this test is why.
 *
 * `@cloudsforge/db` checksums `migration.up` over its whole text, SQL comments included
 * (`runtime/packages/db/src/index.ts:113-122`), and refuses a migration whose text changed after it
 * was applied (`:179-184`). Migrations 5 and 13 are applied in the live estate. Editing a stale
 * citation inside one would change its checksum — measured: migration 13 goes `1436c7c1` →
 * `f1c23cac` — and tessera would then refuse to boot against every database that already ran it.
 *
 * So the two stale numbers in migration 13's prose stay stale, on purpose. This test pins the fact
 * that they are UNEDITABLE rather than merely un-edited, so nobody "tidies" them later.
 */
test('the applied migrations are byte-stable, so their prose cannot be corrected', async () => {
  const { MIGRATIONS } = await import('./migrations.ts')
  const { checksumOf } = await import('@cloudsforge/db')
  // The checksums the live estate recorded. Read from its `schema_migrations` table.
  const RECORDED: Readonly<Record<number, string>> = { 5: '5d286e99', 13: '1436c7c1' }
  for (const [version, expected] of Object.entries(RECORDED)) {
    const migration = MIGRATIONS.find((m) => m.version === Number(version))
    assert.ok(migration, `migration ${version} is gone`)
    assert.equal(
      checksumOf(migration),
      expected,
      `migration ${version} changed. If a stale studio citation in its comment was "fixed", revert ` +
        'it: the estate has already applied this migration and will refuse to start.',
    )
  }
})
