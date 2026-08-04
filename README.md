# micro-tessera

A persistent, user-made world you enter in a browser tab: claim ground, fire objects out of a
prompt, open a place people go to, and get paid in EMBER when they buy what you made.

**Design authority: [`ecosystem/23-tessera.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/23-tessera.md).** This
file says what is built, what is not, and what was found while building it. Where the two disagree,
the disagreement is recorded here rather than smoothed over.

Binds **4022**. Schema version **10**.

---

## What it serves

| Route | Gate |
| --- | --- |
| `GET /livez` `GET /readyz` `GET /metrics` | none — rule 4 |
| `GET /v1/title` | none. A descriptor is a capability statement, and worlds reads it before it holds any credential |
| `POST /v1/provision` | `tessera:provision`, service token only. A user token is refused before the scope is even checked |
| `GET /v1/wards` `GET /v1/wards/:id` | **none — the Mosaic is public.** §5's loop opens with "arrive at the Commons … no account wall", and `worlds` already serves its registry unauthenticated because "a launcher listing games cannot require a token". A ward row is geography and occupancy; it names nobody. These authenticated until now, so a stranger following a link got a 401 and the page showed an error state — the last failing check in `beacon smoke`. `publicreads.test.ts` pins how far this goes and no further |
| `…/:id/parcels` `…/:id/presence` | `tessera:read` for a service; any user otherwise. **Still gated deliberately**: presence is where a named person is standing right now, and a parcel carries its `ownerSubject`. The map is public; the register and the room are not |
| `GET /v1/parcels/:id` `GET /v1/parcels/fallow` | `tessera:read` |
| `GET /v1/discover` `GET /v1/terms` | `tessera:read` |
| `GET /v1/objects` `…/:id` `GET /v1/listings` `…/:id` | `tessera:read` |
| `POST /v1/parcels` `…/:id/bank` `…/:id/contest` `PATCH …/:id` | `tessera:write` + `x-user-id`, or a user token |
| `POST /v1/kiln/firings` | as above. **503 `kiln_unconfigured` when no studio upstream is set — a supported mode** |
| `POST /v1/parcels/:id/placements` `DELETE /v1/placements/:id` | as above |
| `POST /v1/listings` | as above |
| `POST/DELETE /v1/wards/:id/presence` `POST /v1/parcels/:id/visits` `…/beacons` | as above |
| `GET /v1/me/parcels` | as above |

## The invariants that are not in this code

Everything below is a constraint, a trigger or a generated column. §11.6's rule, and the reason is
not belt-and-braces: a handler-only guard is bypassed by a bug, a migration, a second service and
an operator with a psql prompt, and every one of those has happened in this estate.

| Invariant | Form | Migration |
| --- | --- | --- |
| A second Homestead | partial unique index | 4 |
| Two parcels overlapping in one ward | GiST exclusion constraint | 4 |
| A thirteenth Deed Slot | CHECK | 4 |
| Selling or releasing a Homestead | BEFORE UPDATE trigger | 4 |
| Banking more than once a year | BEFORE UPDATE trigger, DB clock | 4 |
| Contesting before the 30 days | constraint trigger, DB clock | 4 |
| Holding more parcels than Deed Slots | deferred constraint trigger | 4 |
| Raising the object cap | **generated column** — no statement can | 4 |
| A second object at one content address | unique index | 5 |
| Re-pointing authorship or bytes | BEFORE UPDATE trigger | 5 |
| A third facing | CHECK | 5 |
| Placements past the object cap | deferred constraint trigger, at COMMIT | 5 |
| A price finer than one Spark | CHECK | 6 |
| An on-chain listing | CHECK | 6 |
| A fee that differs between two accounts | trigger against a singleton terms row | 6 |
| Two open bookings for one slot | partial unique index | 6 |
| **Two open bookings OVERLAPPING on one parcel** | **GiST exclusion constraint** | **14** |
| A booking with no escrow hold | CHECK | 6 |
| **A Venue that has posted no rate** | **CHECK** | **14** |
| **A venue rate of zero, so a free hold** | **CHECK** | **14** |
| **A booking priced at anything but the owner's rate** | **BEFORE INSERT trigger** | **14** |
| **A booking of your own Venue** | **BEFORE INSERT trigger** | **14** |
| **A settled or cancelled booking that did not release its hold** | **CHECK** | **14** |
| **A settled booking that paid the owner nothing** | **CHECK** | **14** |
| **Re-pricing, re-timing or re-opening a booking** | **BEFORE UPDATE trigger** | **14** |
| A grant with no ledger entry behind it | NOT NULL | 6 |
| Synthetic footfall | CHECK | 7 |
| More than 60 avatars in a ward instance | deferred constraint trigger | 7 |
| More than 3 beacons per parcel per week | constraint trigger | 7 |
| A URN the contract's parser refuses | CHECK | 8, corrected by 10 |
| An outbox version that is not `major.minor` | CHECK | 2 |
| A null `actor` or `correlationId` on the wire | NOT NULL | 9 |

## What is deliberately absent

Each is asserted as an absence by a test, not by this list.

* **No `setInterval` doing domain work, and no `cfctl-allow` escape hatch.** Presence is pushed by
  a database trigger raising `pg_notify`; fallow is computed on read from three columns.
* **No `SPARK` asset code.** Sparks is a display denomination of EMBER. One asset, one trial
  balance, one number to reconcile against the chain.
* **No price, charge, payment or ledger import in `world.ts`.** Land is claimed free and the
  platform never sells it, and `claimParcel` cannot reach money to be able to charge for it.
* **No promoted, sponsored, boosted or paid anything in `discovery.ts`.** Two signals, and the
  ranking function's input keys are pinned by a test so a third cannot arrive quietly.
* **No `discovery`, `vote_weight`, `safety`, `land` or `fee_discount` entitlement kind.** A billing
  webhook granting one has nowhere to write it.
* **No `subject` parameter on `platformTerms`.** A per-account rate would need one here before it
  needed a column anywhere.

## Running it

```sh
cp .env.example .env          # fill OUTBOX_SIGNING_SECRET and INBOUND_SIGNING_SECRET
pnpm install
pnpm migrate                  # a SEPARATE one-shot process; index.ts never migrates
pnpm start

pnpm check                    # typecheck + tests
```

Tests need a real Postgres whose database name contains `test`:

```sh
docker run -d --name tessera-test-pg -p 127.0.0.1:55434:5432 \
  -e POSTGRES_USER=tessera -e POSTGRES_PASSWORD=tessera -e POSTGRES_DB=tessera_test postgres:17-alpine
export TESSERA_TEST_DATABASE_URL='postgres://tessera:tessera@127.0.0.1:55434/tessera_test'
```

Without it the database tests **skip**, visibly, in the runner's summary. They do not `return` —
six tests in this estate did that and therefore passed, reporting green for work that never ran.

The suite runs `--test-concurrency=1`: every file truncates in `beforeEach`, so parallel files
empty each other's fixtures.

The image needs two named build contexts, as every service in this estate does until the
`@cloudsforge/*` packages are published:

```sh
docker build -t micro-tessera . \
  --build-context runtimepkgs=../runtime --build-context contractspkgs=../contracts
```

**Build it, run it, and curl it.** `micro-service-template`'s image could not boot for months
because its final stage copied `/runtime` but not `/contracts`, past a `link:` symlink its own
entrypoint imported, and CI hid it by reading the image's metadata without ever running it. This
Dockerfile is aetherholm's, which carries both.

## Venue bookings

This section exists because the feature was **recorded as unfixed** in the estate's topic
reconciliation and because the record was right to hold the emitter back: `tessera.venue.booked`
had a producer on paper and none in the running service, and wiring it up first would have shipped
a free hold and a money trap. Migration 14 and `economy.ts` are the repair, and the reasoning lives
in the migration rather than here — this is the index.

* **Who prices a slot: the OWNER, posted on the parcel, in advance.** `parcels.venue_rate_wei`,
  per hour, and **a Venue is a parcel that has posted a rate** —
  `tessera_a_venue_posts_a_rate` refuses `is_venue` with no rate, `tessera_venue_rate_is_positive`
  refuses a rate of zero, and the venue trigger refuses a booking priced at anything other than
  `venue_rate_wei * hours`. A zero-price hold on somebody else's calendar is now unrepresentable
  rather than merely refused: there is no arithmetic over those three rules that reaches one.
  Not the platform, because a booking fee is not a take (§7.2's fifth refusal is about the fee
  and the royalty cap, and a platform-set rate would be the platform pricing a player's land);
  not the booker, because an offer needs a state between "asked" and "held" that
  `bookings_status_known` does not have. `PUT /v1/parcels/:id/venue`.
* **A booking is a SPAN, and overlap is a GiST exclusion constraint.** 1–12 whole hours, and
  `tessera_no_overlapping_bookings` is the rule the partial unique index on `(parcel_id, slot)`
  only ever was a fraction of — 14:00 for three hours and 15:00 for one are different keys and
  the same room. Half-open `[)`, so back-to-back is not overlapping, which is
  `tessera_parcels_do_not_overlap`'s argument applied to time.
* **The other two thirds of the lifecycle exist, and money cannot be stranded.**
  `settleBooking` and `cancelBooking` are one function (`closeBooking`) because the step they
  share — releasing the hold through `POST /reservations/:id/release` — is the one that must
  never be forgotten, and `bookings_terminal_frees_the_money` is the database saying the same
  thing: **a booking that is not `open` names the entry that gave the money back, or it does not
  exist.** Settling then pays the owner (§8.4, "Earned: … venue bookings"); cancelling pays
  nobody. `economy.test.ts` opens a booking, drives it to each terminal state, and asserts the
  `reserved` balance is the price while open and **zero** after — at both ends, because the zero
  alone would pass against a ledger that never reserved anything.
* **`ledger:reserve` opened itself**, as `grant-gaps.json` said it would: this repository now
  exports `LEDGER_SCOPES` from `ledgerclient.ts`, `micro-deploy`'s `derive-grants.mjs` reads it,
  and the gaps entry for `tessera/src/ledgerclient.ts` is stale by that tool's own rule. Deleting
  it is `micro-deploy`'s edit.

`POST /v1/parcels/:id/bookings` reserves before it writes, because `bookings_open_holds_money`
refuses an open booking that names no hold — and **releases the hold if the booking then fails**,
because a reservation that outlives its booking is the same stranded EMBER arrived at from the
other side.

## What is not built

Phase 2 and beyond, stated so nobody looks for it:

* **The Registry of Authorship contract itself.** `recordAnchor` and `tessera.object.anchored`
  exist and are tested; the Solidity contract, its deployment through `mint`, and the job that
  calls it do not. §9.3 gates v2 on two named changes in other repositories — a `user` signing
  purpose in `custody` and a log-query surface in `indexer` — and neither has landed.
* **Ward governance minting a `micro-community` community.** `wards.community_id` exists and
  `community.proposal.executed` is consumed and applied; nothing creates the community yet.
* **Market and billing HTTP calls.** `draftListing` writes the Tessera half with its terms
  snapshotted; the `POST` to `micro-market` that turns a draft into a live listing is not wired.
  `activateListing` is the seam it will call.
* **`micro-tessera-web`.** A separate repository, against the routes above.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, under
human direction and review.
