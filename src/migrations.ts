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
  'contests',
  'parcels',
  'accounts',
  'wards',
])
