/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * **A released migration is immutable.** `@cloudsforge/db` checksums each one and refuses a run
 * where the text changed after it was applied, because two databases would then disagree about
 * what "version 3" means. The fix for a wrong migration is always a new migration.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * WHY SO MUCH OF THIS TITLE'S LOGIC IS DDL RATHER THAN TYPESCRIPT
 *
 * 23-tessera.md §11.6 asks for invariants in the schema, and this file is where the design's
 * refusals actually become refusals. The reasoning is not "belt and braces": a handler-only guard
 * is bypassed by a bug, by a migration, by a second service, and by an operator with a psql
 * prompt. Every one of those has happened in this estate. The specific ones this file makes
 * unrepresentable rather than merely refused:
 *
 *   * A second Homestead (partial unique index, migration 4). §4 — "You can always come home, and
 *     you cannot hoard the commons."
 *   * Two parcels overlapping in one ward (GiST exclusion constraint, migration 4). This is also
 *     the answer to §12's test 5 — two replicas racing one claim produce exactly one claim —
 *     and it holds whether or not the lease does.
 *   * A thirteenth Deed Slot (CHECK, migration 4). §7.3 — the pay-to-win ceiling, "at any price".
 *   * Selling a Homestead (constraint trigger, migration 4). §6.2 — "Tradeable? no".
 *   * A price finer than one Spark (CHECK, migration 6). §8.1.
 *   * A platform fee that differs between two accounts (constraint trigger, migration 6). §7.2's
 *     fifth refusal, which is the condition the whole no-pay-to-win argument rests on.
 *   * An on-chain listing (CHECK, migration 6). §8.5 — the royalty is enforced ONLY on the
 *     custodial settlement path, so a non-custodial Tessera listing is a royalty that does not
 *     exist.
 *   * More objects on a parcel than its cap (deferred constraint trigger, migration 5), checked
 *     at COMMIT so a 200-object paste is one check rather than two hundred.
 *   * Contesting a fallow parcel before its thirty days (constraint trigger on the DATABASE
 *     clock, migration 4).
 *   * Synthetic footfall (CHECK, migration 7). §8.6 — "a platform that fakes footfall is a
 *     platform rigging its own discovery", and footfall is half the ranking function.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

/**
 * One Spark in wei. §8.1: "A Spark is 10⁻⁶ EMBER — one micro-EMBER, exactly 10¹² wei."
 *
 * EMBER has 18 decimals (`contracts/packages/chain/src/index.ts:53`), so 10^(18-6) = 10^12.
 * Spelled here as a SQL literal and in `sparks.ts` as a `bigint`, and `sparks.test.ts` asserts
 * the two agree — a rate written twice is the estate's oldest failure shape.
 */
export const WEI_PER_SPARK_SQL = '1000000000000'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift. Copying the DDL by hand is how a service ends up with a jobs
    // table missing the (kind, key) unique constraint, which silently turns every recurring
    // enqueue into a duplicate run.
    up: JOBS_SCHEMA_SQL,
  },

  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        -- ═══════════════════════════════════════════════════════════════════════════════════
        -- THE VERSION IS TEXT, AND THAT IS THE WHOLE POINT OF THIS COLUMN.
        --
        -- \`EventVersion\` is \`\\\`\${number}.\${number}\\\`\` (contracts/packages/events/src/index.ts:110)
        -- and \`classifyEnvelope\` refuses an integer at the envelope. \`micro-worlds\` stores this
        -- as an \`integer\` (worlds/src/migrations.ts:65) and maps it to "n.0" on the wire with
        -- \`wireVersion\` (worlds/src/outbox.ts:52) — so the stored value and the wire value are
        -- two different values, and a minor version is unrepresentable in storage.
        --
        -- 23-tessera.md §11.1: "Tessera stores the string, so the stored value and the wire value
        -- are the same value." The CHECK is what makes that true rather than intended: an integer
        -- written straight into this column is refused by the database, not silently reformatted
        -- by a mapper on the way out.
        -- ═══════════════════════════════════════════════════════════════════════════════════
        version        text        not null,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz,
        constraint outbox_version_is_major_minor check (version ~ '^[0-9]+\\.[0-9]+$'),
        constraint outbox_topic_shape check (topic ~ '^[a-z0-9_]+(\\.[a-z0-9_]+){2}$'),
        constraint outbox_key_is_not_empty check (length(key) > 0)
      );

      -- The relay's access path. Partial on the unpublished set, so the index stays the size of
      -- the backlog rather than the size of history.
      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      -- Delivery is tracked per (event, subscription) rather than per event. With one flag on the
      -- outbox row, one failing subscriber either blocks every other subscriber or causes the
      -- event to be redelivered to all of them on each retry.
      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },

  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },

  {
    version: 4,
    name: 'world',
    up: `
      -- Needed by the parcel exclusion constraint below: GiST cannot index a uuid equality
      -- without it, and an exclusion constraint on (ward_id =, range &&, range &&) needs both
      -- operator families in one index.
      create extension if not exists btree_gist;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- WARDS. §4: a 256x256 grid, three quarters claimable, one quarter permanently public.
      --
      -- The claimable share is a CHECK rather than a configuration value because §4 states it as
      -- a hard number with a reason — "a ward where every frontage is private becomes a corridor
      -- of walls, and the one thing a social world cannot recover from is having nowhere to
      -- stand". A number defended in prose and left settable in an env var is a number that gets
      -- changed by whoever wants more inventory.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists wards (
        id              uuid        primary key default gen_random_uuid(),
        slug            text        not null unique,
        name            text        not null,
        archetype       text        not null,
        -- Mint order. The Commons is 0; §6.1's "12 wards at launch" is ordinals 0..11.
        ordinal         integer     not null unique,
        grid_size       integer     not null default 256,
        claimable_tiles integer     not null default 49152,
        claimed_tiles   integer     not null default 0,
        -- The micro-community community that governs this ward. Nullable because a ward exists
        -- before its community does, and because community is a separate service reached over
        -- HTTP — a NOT NULL here would make ward minting depend on another service being up.
        community_id    text,
        instances       integer     not null default 1,
        opened_at       timestamptz not null default now(),
        constraint wards_archetype_known check (
          archetype in ('ashfield','terrace','wharf','undercroft','glasshouse','kilnyard','grove','saltflat')
        ),
        constraint wards_grid_is_256 check (grid_size = 256),
        -- 49152 of 65536 is exactly three quarters. Written as the product so a reader can check
        -- the arithmetic without leaving the line.
        constraint wards_three_quarters_claimable check (claimable_tiles = (256 * 256) / 4 * 3),
        constraint wards_claimed_within_claimable check (claimed_tiles between 0 and claimable_tiles),
        constraint wards_instances_positive check (instances >= 1)
      );

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- ACCOUNTS — this service's own row per player, holding the one thing money buys in space.
      --
      -- Not a copy of identity's user: it is the Deed Slot entitlement and nothing else. §7.3:
      -- "Deed Slots (2 -> 12) ... Capped at 12 by CHECK, at any price".
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists accounts (
        subject    text        primary key,
        deed_slots integer     not null default 2,
        created_at timestamptz not null default now(),
        -- §7.3's ceiling, in the only place a monetisation refusal is actually safe. A purchase
        -- path that tried to grant a thirteenth slot fails HERE, not in the handler that grants
        -- it, so no billing webhook, no admin route and no backfill script can raise it.
        constraint tessera_deed_slots_capped check (deed_slots between 2 and 12),
        constraint accounts_subject_is_a_user check (subject like 'user:%')
      );

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- PARCELS.
      --
      -- \`size\`, \`tiles\` and \`object_cap\` are DERIVED, not supplied. §6.2's table is arithmetic:
      -- five objects per eight tiles, applied uniformly, and every row in that table is
      -- (side^2)/8*5 — 160, 640, 2560, 10240. A generated column is the difference between a
      -- budget and a number somebody typed: there is no INSERT that can give a Plot a Quarter's
      -- object cap, because the cap is not an input.
      --
      -- THE OBJECT CAP IS NOT PURCHASABLE, and this is where that is true. §6.2: "it is a
      -- rendering budget, it is stated as one, and it is not purchasable at any price — the
      -- reference sold prims, which converted 'how much can you build' into 'how much can you
      -- pay'". A generated column has no UPDATE path at all: \`update parcels set object_cap = …\`
      -- is a Postgres error (55000, "cannot insert a non-DEFAULT value into column"). There is no
      -- SKU that can raise it because there is no statement that can raise it.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists parcels (
        id              uuid        primary key default gen_random_uuid(),
        ward_id         uuid        not null references wards (id) on delete restrict,
        owner_subject   text        not null references accounts (subject) on delete restrict,
        tier            text        not null,
        origin_x        integer     not null,
        origin_y        integer     not null,
        size            integer     not null,
        tiles           integer     generated always as (size * size) stored,
        object_cap      integer     generated always as (size * size / 8 * 5) stored,
        status          text        not null default 'held',
        is_venue        boolean     not null default false,
        is_workshop     boolean     not null default false,
        gate_open       boolean     not null default false,
        commissioned    boolean     not null default false,
        claimed_at      timestamptz not null default now(),
        last_footfall_at timestamptz,
        last_edit_at    timestamptz,
        banked_until    timestamptz,
        banked_at       timestamptz,
        released_at     timestamptz,

        -- ─────────────────────────────────────────────────────────────────────────────────────
        -- THE FALLOW CLOCK: ONE GENERATED COLUMN, NO SWEEP, AND ONE THING POSTGRES REFUSED.
        --
        -- §4: "Fallow is computed lazily on read from (lastFootfallAt, lastEditAt, bankedUntil)
        -- and settled on write ... There is no per-day sweep marking parcels dead, because that
        -- would be a timer doing domain work and CI forbids it
        -- (org/.github/workflows/service-ci.yml:1043-1054)."
        --
        -- \`last_active_at\` is stored, because \`greatest\` over timestamptz IS immutable and
        -- because it is the column the fallow read range-scans.
        --
        -- The two deadlines are NOT stored, and the reason is measured rather than assumed. The
        -- first draft carried \`fallow_at\` and \`contestable_at\` as generated columns too and
        -- Postgres refused the migration outright: "generation expression is not immutable". It is
        -- right — \`timestamptz + interval\` is STABLE, not IMMUTABLE, because a day or month
        -- interval is resolved against the session TimeZone, so the same row could generate two
        -- different values in two sessions and the stored value would be a lie in one of them.
        --
        -- So the deadlines are computed where they are used — \`tessera_fallow_deadline()\` below,
        -- used by the contest trigger and by \`fallow.ts\` — and the index on \`last_active_at\`
        -- keeps "which parcels are past 90 days" a range scan rather than a sequential one. This
        -- is the same conclusion §4 reached from the design side, reached again from the storage
        -- side: the part that changes without a write must not be materialised.
        -- ─────────────────────────────────────────────────────────────────────────────────────
        last_active_at  timestamptz generated always as (
          greatest(claimed_at, coalesce(last_footfall_at, claimed_at), coalesce(last_edit_at, claimed_at))
        ) stored,

        constraint tessera_parcel_tier_known check (tier in ('homestead','plot','court','quarter')),
        -- THERE IS NO 'fallow' STATUS, AND ITS ABSENCE IS THE DESIGN. §4 makes fallow a function
        -- of three timestamps evaluated against now(), not a stored flag, precisely so that
        -- nothing has to write it. A 'fallow' value in this column would need something to set
        -- it, and the only thing that could is a nightly sweep — the timer doing domain work that
        -- service-ci.yml:1036-1056 fails the build over. \`fallowStateOf\` in fallow.ts computes
        -- it; \`parcels_fallow_idx\` makes computing it cheap.
        constraint tessera_parcel_status_known check (status in ('held','released')),
        -- The tier IS the size. Storing both and letting them disagree would make \`object_cap\`
        -- derived from a number the tier does not imply, which is the whole budget silently wrong.
        constraint tessera_parcel_size_matches_tier check (
          (tier = 'homestead' and size = 16)
          or (tier = 'plot' and size = 32)
          or (tier = 'court' and size = 64)
          or (tier = 'quarter' and size = 128)
        ),
        constraint tessera_parcel_within_ward check (
          origin_x >= 0 and origin_y >= 0 and origin_x + size <= 256 and origin_y + size <= 256
        ),
        -- §4: "The Homestead is the floor nobody can take ... never fallow, never contestable."
        -- Banking a Homestead is meaningless, so it is refused rather than ignored: an accepted
        -- no-op is a user who believes they spent their one bank of the year.
        constraint tessera_homestead_is_never_banked check (
          tier <> 'homestead' or (banked_until is null and banked_at is null)
        ),
        constraint tessera_released_has_a_timestamp check ((status = 'released') = (released_at is not null))
      );

      create index if not exists parcels_owner_idx on parcels (owner_subject) where status = 'held';
      create index if not exists parcels_ward_idx on parcels (ward_id) where status = 'held';
      -- The lazy fallow read's access path: "which held parcels have been quiet since <date>" is
      -- a range scan on a stored column, which is what makes computing-on-read affordable and is
      -- therefore what makes the absence of a sweep affordable.
      create index if not exists parcels_last_active_idx on parcels (last_active_at) where status = 'held';

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE FALLOW DEADLINE, SPELLED ONCE.
      --
      -- STABLE rather than IMMUTABLE, deliberately and unavoidably: it adds an interval to a
      -- timestamptz, which is the operation that cannot be stored (see the column comment above).
      -- STABLE is enough for what it is used for — a WHERE clause and a trigger, both inside one
      -- statement — and it is what stops the 90 and the 30 being written out in four places and
      -- disagreeing in one of them.
      --
      -- \`banked_until\` participates through \`greatest\`, so banking extends the clock and never
      -- shortens it: a bank that landed before the parcel's last activity has no effect at all
      -- rather than pulling the deadline backwards.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function tessera_fallow_at(
        last_active timestamptz, banked_until timestamptz
      ) returns timestamptz
        language sql stable
      as $$
        select greatest(last_active + interval '90 days', coalesce(banked_until, last_active))
      $$;

      create or replace function tessera_contestable_at(
        last_active timestamptz, banked_until timestamptz
      ) returns timestamptz
        language sql stable
      as $$
        select tessera_fallow_at(last_active, banked_until) + interval '30 days'
      $$;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- A SECOND HOMESTEAD IS UNREPRESENTABLE. §4, and §12's first test.
      --
      -- The form is identity's (identity/src/migrations.ts:292-294): a partial unique index, not
      -- a handler check. "Refused" and "unrepresentable" are different guarantees, and only the
      -- second one survives a bug, a migration, a second replica and an operator with a psql
      -- prompt. \`world.test.ts\` proves it with a raw INSERT and no handler in the picture, which
      -- is the only version of that test that says anything about the database.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists tessera_one_homestead
        on parcels (owner_subject)
        where tier = 'homestead' and status = 'held';

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- TWO PARCELS MAY NOT OVERLAP. The claim race, decided by Postgres rather than by a lease.
      --
      -- §12's test 5 asks that "two replicas racing one parcel claim produce exactly one claim.
      -- Lease, not luck." The lease (\`parcel:<id>\`, jobs.ts) serialises the WORK; this is what
      -- makes the outcome correct even when the lease is not held — a route called directly, a
      -- backfill, a second service. An exclusion constraint takes a predicate lock on the range,
      -- so the loser of a concurrent insert gets 23P01 rather than a second overlapping claim.
      --
      -- Ranges are half-open: [origin, origin+size). A parcel at x=0 size=16 and one at x=16 are
      -- adjacent, not overlapping, and int4range's default '[)' bound says exactly that.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      do $$ begin
        alter table parcels add constraint tessera_parcels_do_not_overlap
          exclude using gist (
            ward_id with =,
            int4range(origin_x, origin_x + size) with &&,
            int4range(origin_y, origin_y + size) with &&
          ) where (status = 'held');
      exception when duplicate_object then null; end $$;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE HOMESTEAD IS NOT TRADEABLE. §6.2's table, as an error rather than a policy.
      --
      -- BEFORE UPDATE rather than a constraint trigger: the write must be refused before it
      -- happens, and there is no legal intermediate state within a transaction where a Homestead
      -- briefly belongs to somebody else. Deferring this would mean a transaction that transfers
      -- a Homestead and then transfers it back committed successfully, having done a thing the
      -- design says cannot be done.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function tessera_guard_homestead() returns trigger
        language plpgsql
      as $$
      begin
        if old.tier = 'homestead' and new.owner_subject is distinct from old.owner_subject then
          raise exception
            'parcel % is a Homestead — it is not tradeable (23-tessera.md §6.2)', old.id
            using errcode = 'check_violation';
        end if;
        -- A Homestead cannot be released either: releasing it and re-claiming the ground is a
        -- transfer with two extra steps, and §4 says "never contestable" without an exception.
        if old.tier = 'homestead' and new.status <> 'held' then
          raise exception
            'parcel % is a Homestead — it is never released (23-tessera.md §4)', old.id
            using errcode = 'check_violation';
        end if;
        -- The tier is what the object cap and the fallow exemption are derived from. Editing it
        -- in place is how a Plot becomes a Quarter without anyone claiming a Quarter.
        if new.tier is distinct from old.tier then
          raise exception
            'parcel % may not change tier — claim the ground you want', old.id
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists parcels_homestead_guard on parcels;
      create trigger parcels_homestead_guard
        before update on parcels
        for each row execute function tessera_guard_homestead();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- BANKING IS ONCE PER YEAR, ON THE DATABASE CLOCK.
      --
      -- §4: "An owner may bank a parcel once per year, extending the clock to 270 days, free."
      -- \`now()\` is the database's clock for the same reason community's timelock uses it
      -- (community/src/migrations.ts:720-752): a handler comparing its own clock to a timestamp
      -- is one NTP failure away from letting a parcel be banked every day.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function tessera_guard_banking() returns trigger
        language plpgsql
      as $$
      begin
        if new.banked_at is distinct from old.banked_at and new.banked_at is not null then
          if old.banked_at is not null and new.banked_at < old.banked_at + interval '365 days' then
            raise exception
              'parcel % was banked at % — banking is once per year (23-tessera.md §4)', old.id, old.banked_at
              using errcode = 'check_violation';
          end if;
          -- 270 days from the last activity, not from now: banking is an extension of the clock
          -- that is already running, and re-basing it on the bank time would make banking on day
          -- 89 worth more than banking on day 1.
          if new.banked_until is null
             or new.banked_until <> greatest(new.claimed_at,
                                             coalesce(new.last_footfall_at, new.claimed_at),
                                             coalesce(new.last_edit_at, new.claimed_at)) + interval '270 days'
          then
            raise exception
              'banking sets banked_until to last activity + 270 days, nothing else'
              using errcode = 'check_violation';
          end if;
        end if;
        return new;
      end;
      $$;

      drop trigger if exists parcels_banking_guard on parcels;
      create trigger parcels_banking_guard
        before update on parcels
        for each row execute function tessera_guard_banking();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- CONTESTS, AND THE THIRTY DAYS THAT CANNOT BE SKIPPED.
      --
      -- §4: "A non-Homestead parcel with no visitor and no edit for 90 days becomes fallow; after
      -- a further 30 days its claim may be contested by anyone."
      --
      -- A CONSTRAINT TRIGGER, because the fact lives on \`parcels\` and Postgres does not defer
      -- CHECK constraints — \`ADD CONSTRAINT … CHECK … DEFERRABLE\` is a syntax error, not a
      -- silently-immediate constraint (the note community/src/migrations.ts:665 leaves).
      -- \`initially immediate\`, unlike the object cap below: there is no bulk shape that benefits
      -- from deferring a window check, and an immediate raise names the offending contest row
      -- rather than the transaction.
      --
      -- Evaluated on now() — the DATABASE clock — so a caller cannot contest early by lying about
      -- the time, and two replicas cannot disagree about whether the window has passed.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists contests (
        id                  uuid        primary key default gen_random_uuid(),
        parcel_id           uuid        not null references parcels (id) on delete cascade,
        challenger_subject  text        not null references accounts (subject) on delete restrict,
        opened_at           timestamptz not null default now(),
        status              text        not null default 'open',
        resolved_at         timestamptz,
        constraint contests_status_known check (status in ('open','won','withdrawn')),
        constraint contests_resolved_has_a_timestamp check ((status = 'open') = (resolved_at is null))
      );

      create unique index if not exists tessera_one_open_contest
        on contests (parcel_id)
        where status = 'open';

      create or replace function tessera_assert_contest_window() returns trigger
        language plpgsql
      as $$
      declare
        p record;
      begin
        select id, tier, status, owner_subject,
               tessera_contestable_at(last_active_at, banked_until) as contestable_at
          into p
          from parcels where id = new.parcel_id;
        if p is null then
          raise exception 'no parcel %', new.parcel_id using errcode = 'foreign_key_violation';
        end if;
        if p.tier = 'homestead' then
          raise exception
            'parcel % is a Homestead — it is never contestable (23-tessera.md §4)', p.id
            using errcode = 'check_violation';
        end if;
        if p.status <> 'held' then
          raise exception
            'parcel % is %, not held — there is nothing to contest', p.id, p.status
            using errcode = 'check_violation';
        end if;
        if now() < p.contestable_at then
          raise exception
            'parcel % is contestable from % — 90 days fallow then 30 more (23-tessera.md §4)',
            p.id, p.contestable_at
            using errcode = 'check_violation';
        end if;
        if p.owner_subject = new.challenger_subject then
          raise exception
            'an owner may not contest their own parcel — bank it instead'
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists contests_respect_the_window on contests;
      create constraint trigger contests_respect_the_window
        after insert on contests
        deferrable initially immediate
        for each row execute function tessera_assert_contest_window();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- DEED SLOTS BOUND HOLDINGS, CHECKED AT COMMIT.
      --
      -- §6.2: non-Homestead parcels are held "up to the Deed Slot cap". Deferred, because a
      -- transaction that releases one parcel and claims another is legal and would fail an
      -- immediate check depending on statement order — which would make a correct operation
      -- depend on which line the developer wrote first.
      --
      -- The Homestead is excluded from the count: it is the floor everyone gets, and counting it
      -- would mean a new account with two Deed Slots could hold one Homestead and one Plot.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function tessera_assert_deed_slots() returns trigger
        language plpgsql
      as $$
      declare
        held    integer;
        allowed integer;
        subj    text;
      begin
        subj := new.owner_subject;
        select deed_slots into allowed from accounts where subject = subj;
        if allowed is null then
          raise exception 'no tessera account for %', subj using errcode = 'foreign_key_violation';
        end if;
        select count(*) into held
          from parcels
         where owner_subject = subj and status = 'held' and tier <> 'homestead';
        if held > allowed then
          raise exception
            '% holds % non-Homestead parcels but has % Deed Slots (23-tessera.md §6.2)',
            subj, held, allowed
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists parcels_within_deed_slots on parcels;
      create constraint trigger parcels_within_deed_slots
        after insert or update on parcels
        deferrable initially deferred
        for each row execute function tessera_assert_deed_slots();
    `,
  },

  {
    version: 5,
    name: 'kiln',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- OBJECTS, AND THE ANSWER TO COPYBOT — WHICH IS AN ADDRESSING SCHEME, NOT A POLICY.
      --
      -- §9.2: "A Tessera object IS its bytes. Re-uploading identical bytes does not create a
      -- second object with a second owner; it resolves to the existing content address and its
      -- existing Author of record. The forgeable \`owner\` field simply does not exist, because
      -- ownership is derived rather than stored."
      --
      -- \`tessera_objects_are_their_bytes\` below is that sentence as a unique index. There is no
      -- \`owner_subject\` column on this table at all — only \`author_subject\`, which is written
      -- once by the firing and never updated (\`objects_authorship_is_final\`). Who may PLACE an
      -- object is a licence question answered by \`placements\` and by micro-market's royalty;
      -- who MADE it is a fact about the file.
      --
      -- What this does not solve, per §9.2 and said here so nobody reads the index as a stronger
      -- claim than it is: IMITATION. A chair prompted to look like your chair has different bytes
      -- and this index has nothing to say about it. What dies is cheap, automated, scalable theft.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists objects (
        id             uuid        primary key default gen_random_uuid(),
        author_subject text        not null references accounts (subject) on delete restrict,
        prompt         text        not null,
        category       text        not null,
        footprint      text        not null,
        status         text        not null default 'firing',
        -- 'sha256:<64 lowercase hex>' — studio's own spelling (studio/src/assets.ts:77-79), so a
        -- checksum copied from a studio response is the value this column holds, with no
        -- reformatting step in between that could drop the prefix on one path and not the other.
        checksum       text,
        studio_asset_id text,
        studio_status_url text,
        -- MEASURED off the bytes by studio (studio/src/backend.ts:460, "Read from the bytes
        -- rather than assumed"), never asserted. Nullable while firing; §2.2 records that
        -- emberkin-assets asserts c2pa at write time and never measures it, and that a repo which
        -- asserts it is a repo that will be wrong quietly.
        c2pa           boolean,
        failure_reason text,
        anchor_tx      text,
        anchor_block   bigint,
        anchored_at    timestamptz,
        created_at     timestamptz not null default now(),
        constraint objects_status_known check (status in ('firing','fired','failed')),
        constraint objects_footprint_known check (footprint in ('1x1','2x2')),
        constraint objects_category_known check (category in (
          'seating','surfaces','storage','lighting','structure','flooring',
          'foliage','signage','machines','instruments','vehicles','ornament'
        )),
        constraint objects_checksum_shape check (checksum is null or checksum ~ '^sha256:[0-9a-f]{64}$'),
        -- A fired object without a content address has no identity, which is the one thing this
        -- design says an object always has.
        constraint objects_fired_have_bytes check (status <> 'fired' or checksum is not null),
        constraint objects_failed_say_why check (status <> 'failed' or failure_reason is not null),
        -- §9.3: the anchor is a Hearth transaction or it is nothing. Half an anchor — a block
        -- with no transaction, a timestamp with no block — is a claim the chain does not back.
        constraint objects_anchor_is_whole check (
          (anchor_tx is null and anchor_block is null and anchored_at is null)
          or (anchor_tx is not null and anchor_block is not null and anchored_at is not null)
        ),
        constraint objects_anchor_needs_bytes check (anchor_tx is null or checksum is not null)
      );

      create unique index if not exists tessera_objects_are_their_bytes
        on objects (checksum) where checksum is not null;

      create index if not exists objects_author_idx on objects (author_subject, created_at desc);

      -- Authorship is written once. An UPDATE that re-points it is the forgeable owner field
      -- coming back in through a different column, and it is the single edit that would undo §9.2.
      create or replace function tessera_guard_authorship() returns trigger
        language plpgsql
      as $$
      begin
        if new.author_subject is distinct from old.author_subject then
          raise exception
            'object % has an author of record — authorship is a fact about the file (23-tessera.md §9.2)',
            old.id
            using errcode = 'check_violation';
        end if;
        -- The bytes are the identity, so re-pointing a fired object at different bytes is
        -- creating a different object while keeping the first one's provenance and sales.
        if old.checksum is not null and new.checksum is distinct from old.checksum then
          raise exception
            'object % is addressed by its bytes — they do not change', old.id
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists objects_authorship_is_final on objects;
      create trigger objects_authorship_is_final
        before update on objects
        for each row execute function tessera_guard_authorship();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- PLACEMENTS, AND TWO FACINGS RATHER THAN FOUR.
      --
      -- §2.1: "One canonical facing per object. The second facing is a horizontal mirror applied
      -- at render time, not a second asset. This is not laziness, it is forced: micro-studio has
      -- no \`seed\` column (studio/src/migrations.ts:154-252) ... A pipeline that cannot fix a seed
      -- cannot render the same chair four times."
      --
      -- The CHECK is a two-value enum, so the day studio stores a seed the change is a migration
      -- that widens it and not a hunt for every place four facings were assumed.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists placements (
        id         uuid        primary key default gen_random_uuid(),
        parcel_id  uuid        not null references parcels (id) on delete cascade,
        object_id  uuid        not null references objects (id) on delete restrict,
        x          integer     not null,
        y          integer     not null,
        facing     text        not null default 'canonical',
        placed_by  text        not null references accounts (subject) on delete restrict,
        placed_at  timestamptz not null default now(),
        constraint placements_facing_is_one_of_two check (facing in ('canonical','mirrored')),
        constraint placements_within_parcel check (x >= 0 and y >= 0 and x < 128 and y < 128)
      );

      create index if not exists placements_parcel_idx on placements (parcel_id);
      create index if not exists placements_object_idx on placements (object_id);

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE OBJECT CAP, CHECKED AT COMMIT.
      --
      -- §12's test 6: "Placing past the object cap is refused at commit by the deferred trigger,
      -- including via a bulk paste that is individually under the cap and collectively over it."
      --
      -- DEFERRED is the whole design of this one. §11.6: "Placements may not exceed the parcel's
      -- cap, checked \`deferrable initially deferred\` at commit — so pasting 200 objects is one
      -- check, not 200." An immediate per-row trigger would run the count 200 times and would
      -- still be correct; deferring makes it one count, and — more importantly — makes a paste
      -- that is legal only as a whole (place 200, remove 200, place 200) legal, which an
      -- immediate check would refuse depending on statement order.
      --
      -- The cap comes from \`parcels.object_cap\`, which is a GENERATED column, so there is no
      -- value here that money could have moved. §6.2.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create or replace function tessera_assert_object_cap() returns trigger
        language plpgsql
      as $$
      declare
        placed integer;
        cap    integer;
        target uuid;
      begin
        target := coalesce(new.parcel_id, old.parcel_id);
        select object_cap into cap from parcels where id = target;
        -- The parcel may have been deleted later in the same transaction; a cascade took the
        -- placements with it and there is nothing left to be over the cap of.
        if cap is null then
          return null;
        end if;
        select count(*) into placed from placements where parcel_id = target;
        if placed > cap then
          raise exception
            'parcel % holds % placements but its object cap is % — the cap is a rendering budget and is not purchasable (23-tessera.md §6.2)',
            target, placed, cap
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists placements_within_object_cap on placements;
      create constraint trigger placements_within_object_cap
        after insert or update on placements
        deferrable initially deferred
        for each row execute function tessera_assert_object_cap();

      -- A placement on a parcel is an edit, and an edit resets the fallow clock. Doing it here
      -- rather than in the handler means every path that places an object — route, job, backfill
      -- — resets the clock, which is what makes "no visitor and no edit for 90 days" a statement
      -- about the parcel rather than about one code path.
      create or replace function tessera_touch_parcel_edit() returns trigger
        language plpgsql
      as $$
      begin
        update parcels set last_edit_at = now()
         where id = coalesce(new.parcel_id, old.parcel_id) and status = 'held';
        return null;
      end;
      $$;

      drop trigger if exists placements_touch_parcel on placements;
      create trigger placements_touch_parcel
        after insert or delete on placements
        for each row execute function tessera_touch_parcel_edit();
    `,
  },

  {
    version: 6,
    name: 'economy',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE TAKE IS THE SAME FOR EVERYBODY, AND THAT IS A SINGLETON ROW PLUS A TRIGGER.
      --
      -- §7.2's fifth refusal, which is the condition the entire no-pay-to-win argument rests on:
      -- "The platform fee and the royalty cap are identical for every account, and no SKU, tier or
      -- subscription reduces either. A subscription that cut your marketplace fee would convert
      -- money directly into structural earning advantage over every creator who did not buy it —
      -- which is compound, permanent, and exactly the thing §7.1 forbids."
      --
      -- One row, forced by \`platform_terms_is_a_singleton\`. Every listing's fee is checked
      -- against it by a trigger rather than defaulted from it, because a DEFAULT is a suggestion:
      -- a caller that supplies its own value overrides a default silently and is refused by a
      -- trigger loudly.
      --
      -- The numbers are micro-market's, not new ones: MARKET_PLATFORM_FEE_BPS defaults to 250 and
      -- MARKET_MAX_ROYALTY_BPS to 1000 (market/src/env.ts:183-184). A second set of rates would be
      -- a second answer to "what does the platform take", which is the question §7.2 needs to have
      -- exactly one answer to.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists platform_terms (
        singleton        boolean     primary key default true,
        platform_fee_bps integer     not null,
        max_royalty_bps  integer     not null,
        updated_at       timestamptz not null default now(),
        constraint platform_terms_is_a_singleton check (singleton = true),
        constraint platform_terms_fee_in_range check (platform_fee_bps between 0 and 10000),
        constraint platform_terms_royalty_in_range check (max_royalty_bps between 0 and 10000),
        -- market/src/env.ts:193-198 refuses boot if the two sum to >= 10000. The same refusal,
        -- one layer down, so a row written by anything at all cannot express it.
        constraint platform_terms_leave_the_seller_something
          check (platform_fee_bps + max_royalty_bps < 10000)
      );

      insert into platform_terms (singleton, platform_fee_bps, max_royalty_bps)
      values (true, 250, 1000)
      on conflict (singleton) do nothing;

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- LISTINGS. Tessera's half of a micro-market sale: the terms, snapshotted, before market
      -- ever sees them.
      --
      -- \`price_wei\` is numeric(78,0) — ledger/src/migrations.ts:215 chose 78 digits "because 78
      -- digits holds any uint256", and EMBER is 18 decimals of a uint256. Read as ::text and
      -- turned into a bigint in TypeScript, never a JSON number: Number.MAX_SAFE_INTEGER is about
      -- 9e15 and a single EMBER is 1e18 wei.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists listings (
        id               uuid          primary key default gen_random_uuid(),
        object_id        uuid          not null references objects (id) on delete restrict,
        seller_subject   text          not null references accounts (subject) on delete restrict,
        price_wei        numeric(78,0) not null,
        royalty_bps      integer       not null,
        platform_fee_bps integer       not null,
        settlement_mode  text          not null default 'custodial',
        market_listing_id text         unique,
        status           text          not null default 'draft',
        created_at       timestamptz   not null default now(),

        -- §8.1: "every in-world price is stored in wei and carries CHECK (price_wei %
        -- 1000000000000 = 0) — no price finer than one Spark." A Spark is the floor, in the
        -- database rather than in a validator, so a price of 1 wei is not a rounding decision
        -- somebody has to remember to make.
        constraint tessera_price_whole_sparks check (price_wei % ${WEI_PER_SPARK_SQL} = 0),
        constraint tessera_price_not_negative check (price_wei >= 0),

        -- ─────────────────────────────────────────────────────────────────────────────────────
        -- EVERY TESSERA LISTING IS CUSTODIAL, WITHOUT EXCEPTION — §8.5, and it is not a
        -- preference.
        --
        -- "The royalty is enforced ONLY on the custodial settlement path — market/src/orders.ts:
        -- 299-345 builds the ledger entry inside \`if (listing.settlementMode === 'custodial')\`,
        -- and the \`else\` branch merely demands an \`onchainTransactionId\`. For an \`onchain\`
        -- listing the royalty is recorded on the order row and NEVER POSTED."
        --
        -- So an onchain Tessera listing is a listing whose royalty is a number in a database and
        -- nothing else, which is the reference's copybot grievance with extra steps. A CHECK
        -- rather than a default, for the reason above: a default is a suggestion.
        -- ─────────────────────────────────────────────────────────────────────────────────────
        constraint tessera_listings_are_custodial check (settlement_mode = 'custodial'),
        constraint listings_status_known check (status in ('draft','active','sold','withdrawn')),
        constraint listings_royalty_not_negative check (royalty_bps >= 0),
        constraint listings_terms_leave_the_seller_something
          check (royalty_bps + platform_fee_bps < 10000),
        -- An active listing names the market listing it became. Without this a Tessera row can
        -- claim to be live while micro-market has never heard of it.
        constraint listings_active_names_its_market_row
          check (status = 'draft' or market_listing_id is not null)
      );

      create index if not exists listings_seller_idx on listings (seller_subject, created_at desc);
      create index if not exists listings_object_idx on listings (object_id);

      create or replace function tessera_assert_one_rate_for_everybody() returns trigger
        language plpgsql
      as $$
      declare
        t record;
      begin
        select platform_fee_bps, max_royalty_bps into t from platform_terms where singleton;
        if t is null then
          raise exception 'platform terms are unset — no listing may be priced'
            using errcode = 'check_violation';
        end if;
        if new.platform_fee_bps <> t.platform_fee_bps then
          raise exception
            'listing % takes %bps but the platform take is %bps — the rate is identical for every account, and no SKU reduces it (23-tessera.md §7.2)',
            new.id, new.platform_fee_bps, t.platform_fee_bps
            using errcode = 'check_violation';
        end if;
        if new.royalty_bps > t.max_royalty_bps then
          raise exception
            'listing % sets a %bps royalty but the cap is %bps — the cap is identical for every account',
            new.id, new.royalty_bps, t.max_royalty_bps
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists listings_one_rate_for_everybody on listings;
      create trigger listings_one_rate_for_everybody
        before insert or update on listings
        for each row execute function tessera_assert_one_rate_for_everybody();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- VENUE BOOKINGS. §6.4 — a Venue is "a parcel flagged for events; gains Beacon rights and a
      -- bookable calendar", and a booking is "an escrowed ledger hold" (§5).
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists bookings (
        id             uuid          primary key default gen_random_uuid(),
        parcel_id      uuid          not null references parcels (id) on delete cascade,
        slot           timestamptz   not null,
        booked_by      text          not null references accounts (subject) on delete restrict,
        price_wei      numeric(78,0) not null,
        -- The ledger reservation that holds the money. §8.2: reserving funds is a posting from
        -- \`available\` to \`reserved\`, "two accounts, not two columns" (ledger/src/accounts.ts:9).
        reservation_id text,
        status         text          not null default 'open',
        created_at     timestamptz   not null default now(),
        constraint bookings_status_known check (status in ('open','settled','cancelled')),
        constraint tessera_booking_price_whole_sparks check (price_wei % ${WEI_PER_SPARK_SQL} = 0),
        constraint tessera_booking_price_not_negative check (price_wei >= 0),
        -- A slot on the hour. A calendar whose slots are arbitrary instants cannot be shown as a
        -- calendar, and two "same" slots a millisecond apart would both be open.
        constraint bookings_slot_is_on_the_hour check (date_trunc('hour', slot) = slot),
        -- An open booking holds money or it is not holding a slot: §6.4's bookable calendar is a
        -- promise the venue owner can rely on, and a free hold is a denial-of-service on it.
        constraint bookings_open_holds_money check (status <> 'open' or reservation_id is not null)
      );

      -- §11.6: "create unique index tessera_one_open_booking on bookings (parcel_id, slot) where
      -- status = 'open'". Partial, so a cancelled booking does not block the slot forever.
      create unique index if not exists tessera_one_open_booking
        on bookings (parcel_id, slot) where status = 'open';

      create or replace function tessera_assert_booking_is_a_venue() returns trigger
        language plpgsql
      as $$
      declare
        p record;
      begin
        select id, is_venue, status into p from parcels where id = new.parcel_id;
        if p is null then
          raise exception 'no parcel %', new.parcel_id using errcode = 'foreign_key_violation';
        end if;
        if not p.is_venue then
          raise exception
            'parcel % is not a Venue — only a Venue has a bookable calendar (23-tessera.md §6.4)', p.id
            using errcode = 'check_violation';
        end if;
        if p.status <> 'held' then
          raise exception 'parcel % is % — a released parcel has no calendar', p.id, p.status
            using errcode = 'check_violation';
        end if;
        return new;
      end;
      $$;

      drop trigger if exists bookings_need_a_venue on bookings;
      create trigger bookings_need_a_venue
        before insert on bookings
        for each row execute function tessera_assert_booking_is_a_venue();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- ENGAGEMENT GRANTS. §8.3 and §8.6.
      --
      -- EVERY GRANT NAMES ITS LEDGER ENTRY AND CANNOT BE WRITTEN BEFORE IT —
      -- \`ledger_entry_id\` is NOT NULL, the rule 21 §7.4 states and market/src/engagement.ts
      -- already follows. So the order is always: post to the ledger on a key derived from the
      -- grant, then record. A crash between them leaves an entry with no row — the safe
      -- direction, visible in the ledger, adopted by the retry — never a recorded payment that
      -- never happened.
      --
      -- The debit side is always \`engagement:tessera\`, spelled by \`engagementAccount\` in
      -- @cloudsforge/contracts-money rather than here, and it is an EQUITY account, which is what
      -- makes the ledger refuse a grant the world cannot afford: \`ledger_assert_no_overdraft\`
      -- exempts \`clearing\` and \`suspense\`, not \`equity\` (ledger/src/migrations.ts:441, :479).
      -- §8.3: "not a promise that reserves exist, but a constraint that makes spending
      -- non-existent reserves unrepresentable."
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists engagement_grants (
        id              uuid          primary key default gen_random_uuid(),
        kind            text          not null,
        beneficiary     text          not null references accounts (subject) on delete restrict,
        amount_wei      numeric(78,0) not null,
        ledger_entry_id text          not null,
        idempotency_key text          not null unique,
        created_at      timestamptz   not null default now(),
        constraint engagement_grants_kind_known check (kind in ('firing_allowance','commission','listing_fee_subsidy','first_listing_bounty')),
        constraint engagement_grants_amount_positive check (amount_wei > 0),
        constraint tessera_grant_whole_sparks check (amount_wei % ${WEI_PER_SPARK_SQL} = 0)
      );
    `,
  },

  {
    version: 7,
    name: 'discovery',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- FOOTFALL AND DWELL — THE WHOLE RANKING FUNCTION, AND THE ONLY TWO INPUTS IT WILL EVER
      -- HAVE.
      --
      -- §6.5: "That is the whole ranking function, and the shortness is the point. Dwell is
      -- included because footfall alone rewards a doorway that tricks people in; dwell punishes
      -- it. There is no third signal, and specifically there is no paid one — ever."
      --
      -- Footfall is DISTINCT accounts per parcel per day, so the primary key is
      -- (parcel_id, day, visitor_subject): a second visit by the same person on the same day
      -- updates the row rather than inserting a second one, which makes "distinct accounts" a
      -- property of the table rather than of a \`count(distinct …)\` somebody has to remember.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists visits (
        parcel_id       uuid        not null references parcels (id) on delete cascade,
        day             date        not null,
        visitor_subject text        not null,
        first_entered_at timestamptz not null default now(),
        last_seen_at    timestamptz not null default now(),
        dwell_seconds   integer     not null default 0,
        primary key (parcel_id, day, visitor_subject),

        -- ─────────────────────────────────────────────────────────────────────────────────────
        -- NO SYNTHETIC FOOTFALL. §8.6, as a constraint rather than a promise.
        --
        -- "Tessera adds the world-specific version of the same rule: no synthetic footfall,
        -- because footfall is the ranking signal (§6.5) and a platform that fakes footfall is a
        -- platform rigging its own discovery."
        --
        -- micro-market made the money half of this unrepresentable —
        -- \`escrows_never_platform_funded\`, \`bids_never_platform_funded\`,
        -- \`offers_never_platform_funded\` (market/src/engagement.ts:11-15). This is the world
        -- half: a visit by \`platform\`, \`platform:engagement-treasury\` or any
        -- \`engagement:<service>\` subject cannot be written at all. There is no route that does
        -- it, and after this there is no statement that could.
        -- ─────────────────────────────────────────────────────────────────────────────────────
        constraint tessera_footfall_is_never_synthetic check (visitor_subject like 'user:%'),
        constraint visits_dwell_not_negative check (dwell_seconds >= 0)
      );

      create index if not exists visits_parcel_day_idx on visits (parcel_id, day);

      -- A visit is activity, so it resets the fallow clock — the \`lastFootfallAt\` half of §4's
      -- triple. In the database for the same reason the edit trigger is: so that every path that
      -- records a visit resets it.
      create or replace function tessera_touch_parcel_footfall() returns trigger
        language plpgsql
      as $$
      begin
        update parcels set last_footfall_at = greatest(coalesce(last_footfall_at, new.last_seen_at), new.last_seen_at)
         where id = new.parcel_id and status = 'held';
        return null;
      end;
      $$;

      drop trigger if exists visits_touch_parcel on visits;
      create trigger visits_touch_parcel
        after insert or update on visits
        for each row execute function tessera_touch_parcel_footfall();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- PRESENCE — PUSH ON CHANGE, NEVER POLLED, AND NEVER ON A TIMER.
      --
      -- §4: "A move writes a row and raises a Postgres NOTIFY; the SSE handler forwards it. There
      -- is no broadcast timer anywhere — which is both the rule and, here, the simpler design."
      --
      -- The NOTIFY is raised by a TRIGGER rather than by the handler, so a presence change made
      -- by any path at all is broadcast. A handler-side notify is one code path away from a move
      -- nobody sees.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists presence (
        ward_id    uuid        not null references wards (id) on delete cascade,
        subject    text        not null,
        instance   integer     not null,
        x          integer     not null,
        y          integer     not null,
        updated_at timestamptz not null default now(),
        primary key (ward_id, subject),
        constraint presence_instance_positive check (instance >= 1),
        constraint presence_within_grid check (x between 0 and 255 and y between 0 and 255),
        constraint presence_is_a_person check (subject like 'user:%')
      );

      create index if not exists presence_instance_idx on presence (ward_id, instance);

      -- §6.1: "Ward instance capacity — 60 avatars." §4: "the 61st arrival opens instance 2".
      -- A constraint trigger rather than a handler count, because two arrivals racing would both
      -- read 60 and both write; the trigger runs inside each transaction and the loser raises.
      create or replace function tessera_assert_instance_capacity() returns trigger
        language plpgsql
      as $$
      declare
        occupied integer;
      begin
        select count(*) into occupied
          from presence where ward_id = new.ward_id and instance = new.instance;
        if occupied > 60 then
          raise exception
            'ward % instance % holds % avatars — capacity is 60 and the next arrival opens a new instance (23-tessera.md §4)',
            new.ward_id, new.instance, occupied
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists presence_within_instance_capacity on presence;
      create constraint trigger presence_within_instance_capacity
        after insert or update on presence
        deferrable initially deferred
        for each row execute function tessera_assert_instance_capacity();

      create or replace function tessera_notify_presence() returns trigger
        language plpgsql
      as $$
      declare
        row_now record;
      begin
        row_now := coalesce(new, old);
        perform pg_notify('tessera_presence', json_build_object(
          'wardId', row_now.ward_id,
          'subject', row_now.subject,
          'instance', row_now.instance,
          'x', case when tg_op = 'DELETE' then null else row_now.x end,
          'y', case when tg_op = 'DELETE' then null else row_now.y end,
          'op', lower(tg_op)
        )::text);
        return null;
      end;
      $$;

      drop trigger if exists presence_push_on_change on presence;
      create trigger presence_push_on_change
        after insert or update or delete on presence
        for each row execute function tessera_notify_presence();

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- BEACONS — free, and rate-limited to 3 per parcel per 7 days.
      --
      -- §6.5: "a limit that exists so that a Beacon means something, and which cannot be raised
      -- by paying." There is no \`beacon_allowance\` column for a SKU to grant, and the trigger
      -- reads no entitlement: the limit is the same integer for every account in the world.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists beacons (
        id         uuid        primary key default gen_random_uuid(),
        parcel_id  uuid        not null references parcels (id) on delete cascade,
        lit_by     text        not null references accounts (subject) on delete restrict,
        headline   text        not null,
        lit_at     timestamptz not null default now(),
        constraint beacons_headline_length check (length(headline) between 1 and 200)
      );

      create index if not exists beacons_parcel_idx on beacons (parcel_id, lit_at desc);

      create or replace function tessera_assert_beacon_rate() returns trigger
        language plpgsql
      as $$
      declare
        recent integer;
      begin
        select count(*) into recent
          from beacons
         where parcel_id = new.parcel_id and lit_at > now() - interval '7 days';
        if recent > 3 then
          raise exception
            'parcel % has lit % beacons in seven days — the limit is 3 and it cannot be raised by paying (23-tessera.md §6.5)',
            new.parcel_id, recent
            using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;

      drop trigger if exists beacons_within_rate_limit on beacons;
      create constraint trigger beacons_within_rate_limit
        after insert on beacons
        deferrable initially immediate
        for each row execute function tessera_assert_beacon_rate();
    `,
  },

  {
    version: 8,
    name: 'provisioning',
    up: `
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- THE TITLE CONTRACT'S IDEMPOTENCY. §11.8.
      --
      -- worlds sends \`entitlementId\` as BOTH the Idempotency-Key header and a body field
      -- (worlds/src/titleclient.ts:149), and its conformance suite asks the same provision twice
      -- and requires the same \`urn\` with \`replayed: true\` the second time
      -- (worlds/src/conformance.ts:233-246). The primary key IS the idempotency: a replay
      -- conflicts, and the stored \`urn\` is returned rather than a second Private Ward being
      -- raised for one payment.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists provisions (
        entitlement_id text        primary key,
        subject        text        not null,
        user_id        uuid        not null,
        sku            text        not null,
        scope          text,
        urn            text        not null unique,
        ward_id        uuid        references wards (id) on delete restrict,
        metadata       jsonb       not null default '{}'::jsonb,
        created_at     timestamptz not null default now(),
        constraint provisions_urn_shape check (urn ~ '^urn:cloudsforge:tessera:')
      );

      -- ═══════════════════════════════════════════════════════════════════════════════════════
      -- ENTITLEMENTS this title honours, from micro-billing.
      --
      -- §7.3's table, minus everything §7.1 refuses. \`kind\` is a closed set and the set is the
      -- refusal: there is no 'discovery', no 'vote_weight', no 'safety', no 'land' and no
      -- 'fee_discount' value, so a billing webhook that tried to grant one has nowhere to write
      -- it. §12's test 4 asserts each absence with force rather than trusting this comment.
      -- ═══════════════════════════════════════════════════════════════════════════════════════
      create table if not exists entitlements (
        id             uuid        primary key default gen_random_uuid(),
        subject        text        not null references accounts (subject) on delete restrict,
        kind           text        not null,
        sku            text        not null,
        entitlement_id text        not null unique,
        granted_at     timestamptz not null default now(),
        revoked_at     timestamptz,
        constraint entitlements_kind_known check (kind in (
          'kiln_capacity','deed_slots','appearance','name_reservation','private_ward','venue_calendar'
        ))
      );

      create index if not exists entitlements_subject_idx on entitlements (subject)
        where revoked_at is null;
    `,
  },
]

/**
 * The version this build of the service requires. `index.ts` asserts it at boot and refuses to
 * serve below it, which is what stops a replica of the new code answering requests against the
 * old schema when a deploy runs ahead of its migrator.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * How an existing hand-built schema is adopted. A new service leaves this at 0.
 */
export const BASELINE_VERSION = 0

/**
 * Every table this service owns, in dependency order.
 *
 * Read by the test harness's truncate and by nothing else in production. A list rather than a
 * `pg_tables` query on purpose: a truncate driven by "every table in the schema" empties
 * `schema_migrations` too, and the next run then re-applies migration 1 against a database that
 * already has it.
 */
export const TABLES: readonly string[] = Object.freeze([
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
  'inbox',
  'engagement_grants',
  'bookings',
  'listings',
  'beacons',
  'visits',
  'presence',
  'placements',
  'objects',
  'contests',
  'entitlements',
  'provisions',
  'parcels',
  'accounts',
  'wards',
])
