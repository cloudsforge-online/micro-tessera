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
| `GET /v1/wards` `…/:id` `…/:id/parcels` `…/:id/presence` | `tessera:read` for a service; any user otherwise |
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
| A booking with no escrow hold | CHECK | 6 |
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

## What is not built

Phase 2 and beyond, stated so nobody looks for it:

* **The Registry of Authorship contract itself.** `recordAnchor` and `tessera.object.anchored`
  exist and are tested; the Solidity contract, its deployment through `mint`, and the job that
  calls it do not. §9.3 gates v2 on two named changes in other repositories — a `user` signing
  purpose in `custody` and a log-query surface in `indexer` — and neither has landed.
* **The venue booking route.** `bookVenue` (`src/economy.ts`) and `tessera.venue.booked` exist and
  are tested against a real database; **nothing in the running service calls them, and this is
  unfixed work rather than a decision.** It is deliberately NOT the `recordAnchor` case above:
  that one waits on a Solidity contract nobody has written, whereas every dependency of this one
  already exists — `micro-ledger` serves `POST /reservations` and `POST /reservations/:id/release`
  (`ledger/src/server.ts:448`, `:487`), and `micro-notify` has a finished, unblocked rule for the
  topic (`notify/src/catalogue.ts:1266`, template `templates.ts:467`, tests
  `catalogue.test.ts:969`) resolving the recipient through the `ownerSubject` this emitter puts on
  the payload. Nor is it the `transferParcel` case: no other service in the estate books a venue,
  so there is no duplicate implementation to consolidate into.

  What is missing is the rest of the feature, not a line of wiring:

  * **A rate.** `parcels.is_venue` is a boolean and there is no rate column anywhere;
    `BookInput.priceWei` is an unsourced input, and `price_wei >= 0` admits a zero-price booking.
    Who sets the price of a slot is undecided, and a route cannot be written before it is.
  * **The other two thirds of the lifecycle.** `bookings.status` is
    `open | settled | cancelled` and only the `open` insert exists. A booking that can be opened
    but never settled or cancelled strands a player's EMBER in `reserved` permanently — the
    release half (`POST /reservations/:id/release`) is the part that makes the hold safe, and it
    is the part with no code.
  * **A `ledger:reserve` grant.** Tessera holds `ledger:post` only, and
    `deploy/compose/estate/grant-gaps.json` derives that from the call sites that exist — "it
    reaches no other ledger route". `POST /reservations` is gated on `RESERVE_SCOPE`
    (`ledger/src/server.ts:80`). That block is real but **not external**: it is computed from this
    repository's own source, so it opens by itself the day the call site is written.

  The emitter is the first slice of that feature and it waits for the rest. The half that WOULD
  have been a defect — an emitter whose payload no consumer had ever checked — is closed:
  `economy.test.ts` exercises it against a real database and asserts the outbox row, and
  `contracts.test.ts` pins `keyedBy` to `parcel_id`.

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
