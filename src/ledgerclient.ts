/**
 * `micro-ledger`, over HTTP. The only place this service moves money.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ACCOUNT KEY IS THE CONTRACT'S, AND THE WIRE SHAPE IS THE ONE OTHER SERVICES ALREADY SEND.
 *
 * A ledger account is `(subject, asset_code, purpose)` and nothing else
 * (`ledger/src/accounts.ts:4`). `ledger/src/accounts.ts` THROWS on a `type` mismatch against an
 * account that already exists, and whichever service posts second has **every** entry refused. So
 * a second spelling of `engagement:tessera`, or the same subject with `type: 'expense'` instead of
 * `'equity'`, is not a cosmetic difference; it is this service's entire economy failing at a
 * moment nobody chose. `contracts/packages/money/src/index.ts:205` records that `micro-foresight`
 * "shipped exactly that defect with `foresight.settlement_fee` and posted nothing for months".
 *
 * So: every identity comes from `@cloudsforge/contracts-money` — `engagementAccount`,
 * `userSubject`, the `AccountPurpose` and `AccountType` unions — and the wire body is
 * field-for-field what `market/src/ledgerclient.ts:381-408` sends, including
 * `originatingService`, `actor`, `correlationId`, the inline `account` block, and amounts as
 * decimal STRINGS. Nothing here spells an account by hand.
 *
 * **AND `equity` IS THE SAFETY PROPERTY.** `ledger_assert_no_overdraft` exempts `clearing` and
 * `suspense` and does not exempt `equity` (`ledger/src/migrations.ts:441`, `:479`), so a grant
 * against an unfunded `engagement:tessera` is refused BY THE DATABASE. §8.3: "not a promise that
 * reserves exist, but a constraint that makes spending non-existent reserves unrepresentable."
 * This file's job is to not route around that: there is no `overdraftAllowed` path, no `suspense`
 * fallback, and no branch that posts a one-sided entry.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { HttpClient } from '@cloudsforge/http'
import {
  CLEARING,
  accountKey,
  assertBalanced,
  engagementSubject,
  userSubject,
  type AccountPurpose,
  type AccountType,
  type Actor,
  type LedgerAssetCode,
  type Posting,
  type TokenAssetCode,
} from '@cloudsforge/contracts-money'
import { ASSET } from './sparks.ts'
import { ENGAGEMENT_ACCOUNT, GRANT_ENTRY_KIND, AVAILABLE, PAYOUT_DUE } from './economy.ts'
import { SERVICE } from './env.ts'

/** The wire form of an account. Four fields, all of which the ledger keys or checks on. */
export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: AccountPurpose
  readonly type: AccountType
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export class LedgerError extends Error {
  readonly status: number
  readonly code: string
  constructor(code: string, message: string, status = 502) {
    super(message)
    this.name = 'LedgerError'
    this.code = code
    this.status = status
  }
}

/**
 * Raised when the ledger refuses a posting because the account would go negative.
 *
 * A distinct class, because it is the ONE failure this service must never retry into existence.
 * §8.6's "what it must never spend it on, and cannot" is the same rule from the other side: a
 * retry loop against an unfunded treasury asks the database one question a thousand times and gets
 * the right answer every time.
 */
export class ReserveEmptyError extends LedgerError {
  constructor(message: string) {
    super('engagement_reserve_empty', message, 409)
    this.name = 'ReserveEmptyError'
  }
}

export interface PostEntryRequest {
  readonly kind: string
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly postings: readonly PostingRequest[]
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<{ id: string; replayed: boolean }>
  balances(subject: string): Promise<ReadonlyArray<{ purpose: string; amount: bigint }>>
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  /** A live service token holding `ledger:post`. A function, because a token expires. */
  readonly token: () => Promise<string>
  /** Test seam. */
  readonly client?: Pick<HttpClient, 'request'>
}

/**
 * Balance the entry HERE, before the socket opens.
 *
 * `assertBalanced` is the contract's own check and it takes the RESOLVED `Posting` shape
 * (`accountId`-keyed), while the wire sends the inline `account` block — the two forms
 * `contracts/packages/money/src/index.ts:210-216` explains exist for different jobs. `accountKey`
 * builds the resolved id from the identity, so this checks exactly the accounts the wire names.
 *
 * The ledger has a deferred trigger that enforces the same invariant per `asset_code`
 * (`ledger/src/migrations.ts:302-313`), so this is a second check. Deliberately: an unbalanced
 * entry that fails at the ledger is a round trip and a log line in somebody else's service, while
 * one that fails here names the caller that built it.
 */
export function balanceCheck(postings: readonly PostingRequest[]): void {
  const resolved: Posting[] = postings.map((p) => ({
    accountId: accountKey({
      subject: p.account.subject as never,
      assetCode: p.account.assetCode,
      purpose: p.account.purpose,
    }),
    direction: p.direction,
    amount: p.amount,
    assetCode: p.assetCode,
    sequence: p.sequence,
  }))
  assertBalanced(resolved)
}

export function createLedgerClient(options: LedgerClientOptions): LedgerClient {
  const http = options.client ?? new HttpClient({ baseUrl: options.baseUrl, name: 'ledger' })

  return {
    async postEntry(request) {
      balanceCheck(request.postings)
      try {
        const body = await http.request<{ entry?: { id?: string }; id?: string; replayed?: boolean }>(
          '/entries',
          {
            method: 'POST',
            deadlineMs: 10_000,
            // The key is in the body AND on the request, and both matter. In the body it is what
            // the ledger stores and dedupes on; on the request it is what makes the POST retriable
            // at all, because `HttpClient` attempts a non-idempotent method exactly once without
            // one. `market/src/ledgerclient.ts:383-386` says the same, and the two must agree.
            idempotencyKey: request.idempotencyKey,
            requestId: request.correlationId,
            headers: { authorization: `Bearer ${await options.token()}` },
            body: {
              kind: request.kind,
              originatingService: SERVICE,
              actor: request.actor,
              correlationId: request.correlationId,
              idempotencyKey: request.idempotencyKey,
              ...(request.metadata ? { metadata: request.metadata } : {}),
              postings: request.postings.map((posting) => ({
                direction: posting.direction,
                // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
                // 754 double, and 10^18 wei does not survive one — it does not fail either, it
                // comes back subtly wrong.
                amount: posting.amount.toString(),
                assetCode: posting.assetCode,
                sequence: posting.sequence,
                account: posting.account,
              })),
            },
          },
        )
        const id = body.entry?.id ?? body.id
        if (!id) throw new LedgerError('bad_response', 'the ledger returned no entry id')
        return { id, replayed: body.replayed ?? false }
      } catch (err) {
        throw translate(err)
      }
    },

    async balances(subject) {
      try {
        const response = await http.request<{ balances?: unknown }>(
          `/accounts/${encodeURIComponent(subject)}/balances`,
          {
            method: 'GET',
            deadlineMs: 10_000,
            headers: { authorization: `Bearer ${await options.token()}` },
          },
        )
        const raw = response.balances
        if (!Array.isArray(raw)) return []
        return raw.flatMap((entry) => {
          if (typeof entry !== 'object' || entry === null) return []
          const e = entry as Record<string, unknown>
          if (e['assetCode'] !== ASSET) return []
          const purpose = typeof e['purpose'] === 'string' ? e['purpose'] : null
          const amount = typeof e['amount'] === 'string' ? e['amount'] : null
          // The same `/^\d{1,78}$/`-before-BigInt discipline as `sparks.ts`, with a sign allowed:
          // a balance CAN legitimately be negative on a clearing account, and `BigInt('')` is
          // still `0n`, which here would report an empty treasury as a funded one.
          if (!purpose || !amount || !/^-?\d{1,78}$/.test(amount)) return []
          return [{ purpose, amount: BigInt(amount) }]
        })
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * Turn a ledger failure into something this service can act on.
 *
 * The overdraft trigger raises `check_violation` with a message naming the account and the amount
 * it would go to (`ledger/src/migrations.ts:474-478`). Matching on the SENTENCE rather than on a
 * status code, because a 409 from the ledger could be a dozen things and only this one means "the
 * world cannot pay what it does not hold" — which is the one this service must surface differently
 * and must never retry.
 */
function translate(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (
    message.includes('may not go negative') ||
    message.includes('would go to -') ||
    message.includes('overdraft')
  ) {
    return new ReserveEmptyError(
      `the ledger refused this posting: ${message}. engagement:tessera is an equity account, so ` +
        'an unfunded grant is refused at the database rather than by a handler that forgot to ' +
        'look (23-tessera.md §8.3).',
    )
  }
  if (err instanceof LedgerError) return err
  return new LedgerError('ledger_unavailable', message)
}

/* -------------------------------------------------------------------------- account shapes */

/** A person's own money. Always a `liability`: the platform owes it to them. */
export function holder(subject: string, purpose: AccountPurpose): AccountRef {
  const canonical = subject.startsWith('user:')
    ? userSubject(subject.slice('user:'.length))
    : subject
  return { subject: canonical, assetCode: ASSET, purpose, type: 'liability' }
}

/** The engagement reserve, spelled by the contract. `equity`, which is the whole point. */
export const ENGAGEMENT_REF: AccountRef = {
  subject: ENGAGEMENT_ACCOUNT.subject,
  assetCode: ENGAGEMENT_ACCOUNT.assetCode,
  purpose: ENGAGEMENT_ACCOUNT.purpose,
  type: 'equity',
}

/** The subject the reserve lives under, for a test or an operator to look up. */
export const ENGAGEMENT_SUBJECT = engagementSubject(SERVICE)

/**
 * The two postings of an engagement grant.
 *
 * Debit `engagement:tessera` (equity), credit the beneficiary's `available`. Exported separately
 * from the call so `economy.test.ts` can assert the SHAPE — that the debit side is the engagement
 * account and that its type is the one the ledger refuses an overdraft on — without a ledger
 * being up.
 */
export function grantPostings(beneficiary: string, amountWei: bigint): readonly PostingRequest[] {
  return [
    { account: ENGAGEMENT_REF, direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    {
      account: holder(beneficiary, AVAILABLE),
      direction: 'credit',
      amount: amountWei,
      assetCode: ASSET,
      sequence: 1,
    },
  ]
}

/**
 * Grant EMBER from the engagement reserve.
 *
 * **The refusal path is the interesting one, and it is not implemented here.** If
 * `engagement:tessera` holds nothing, the ledger's `ledger_assert_no_overdraft` trigger raises and
 * this throws `ReserveEmptyError` — from the database, not from a balance check this file could
 * have forgotten to write. There is deliberately no "check the balance first": a check-then-post
 * is a race, and the post is already the check.
 */
export async function grantFromEngagement(
  ledger: LedgerClient,
  input: {
    beneficiary: string
    amountWei: bigint
    kind: string
    idempotencyKey: string
    correlationId: string
  },
): Promise<{ id: string; replayed: boolean }> {
  return ledger.postEntry({
    kind: GRANT_ENTRY_KIND,
    actor: 'system',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    postings: grantPostings(input.beneficiary, input.amountWei),
    metadata: { programme: SERVICE, grantKind: input.kind },
  })
}

/**
 * The two postings that move a booking's money into escrow.
 *
 * §8.2: "The available/reserved split is two accounts, not two columns. Reserving funds is a
 * posting from `available` to `reserved`, which makes a reservation auditable, reversible and
 * impossible to lose track of" (`ledger/src/accounts.ts:9`).
 */
export function reservePostings(subject: string, amountWei: bigint): readonly PostingRequest[] {
  return [
    { account: holder(subject, 'available'), direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    { account: holder(subject, 'reserved'), direction: 'credit', amount: amountWei, assetCode: ASSET, sequence: 1 },
  ]
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THERE IS NO PAYOUT FUNCTION HERE, AND ITS ABSENCE IS A CORRECTION RATHER THAN AN OMISSION.
 *
 * This file used to export `releasePostings` and `releasePayout`, moving a creator's cleared
 * proceeds from `payout_due` to `available`. They had ZERO CALLERS, which read like unfinished
 * work and was in fact a hazard: **micro-market already does both halves, and Tessera doing them
 * too would be a second service releasing one payout.**
 *
 * Read out of market's source rather than assumed:
 *
 *   * **The credit.** Settlement is one balanced entry whose proceeds leg lands in the SELLER's
 *     `payout_due` — `market/src/orders.ts:339` (`proceedsPurpose: holdProceeds ? 'payout_due' :
 *     'available'`) on `subject: listing.sellerSubject` (`:388`).
 *   * **The release.** `releaseProceeds` (`market/src/orders.ts:696`) moves `payout_due` →
 *     `available` once `payout_due_at` has passed, driven by a LEASED JOB — `PAYOUT_KIND`,
 *     `market/src/jobs.ts:322`, fed by `duePayouts` (`orders.ts:789`).
 *
 * So a creator IS paid, end to end, by the service that holds the sale. What was actually missing
 * was never a payout: it was that **no Tessera listing had ever reached micro-market**, so no sale
 * could settle and there was nothing to release. `activateListing` is that fix, and it is why this
 * function is not.
 *
 * A Tessera release would debit `user:<creator> / EMBER / payout_due` for money market had already
 * moved. The ledger would REFUSE it — a user's `payout_due` is `liability`, which
 * `ledger_assert_no_overdraft` does not exempt — so it would fail loudly rather than silently
 * double-pay. That is the ledger being right, not a reason to keep the code: `market/src/escrow.ts`
 * calls the same shape "market has become a second ledger and the trial balance has stopped
 * meaning anything", and this is that from the other side.
 *
 * **What Tessera's money genuinely is: engagement grants out of `engagement:tessera`, and booking
 * reservations.** Sale proceeds are market's. `economy.test.ts` asserts this over the whole
 * repository as ZERO `payout_due` debit sites, because "Tessera never releases a payout" is a
 * claim about the repository that no single call site can make.
 *
 * `PAYOUT_DUE` is still imported, and only for READING: `GET /v1/me/balances` shows a creator what
 * they are owed and what has cleared. Showing a balance is not moving one.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** §8.2's three figures, and no fourth. Every one a `bigint`; the wire carries decimal strings. */
export interface Wallet {
  /** Spendable now. */
  readonly availableWei: bigint
  /** Held against an open venue booking. Theirs, but committed. */
  readonly reservedWei: bigint
  /** Sold, not yet cleared. Market releases it when the dispute window runs — see above. */
  readonly payoutDueWei: bigint
}

/**
 * What a player has, read from the ledger.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ABSENT BALANCE IS ZERO HERE, AND THAT IS SAFE ONLY BECAUSE OF WHERE IT IS DECIDED.**
 *
 * `micro-tessera-web` refuses to print a digit it cannot obtain, on the grounds that a zero is
 * `BigInt('')` — the estate's oldest money hazard, an empty string silently becoming zero on a
 * screen showing somebody their own earnings. That instinct is right and this function does not
 * undermine it: the zero below is not parsed from an empty string, it is the ledger's own answer.
 * An account with no postings HAS no balance row, and `0n` is the true reading of that.
 *
 * The distinction the client needs is preserved by the ROUTE rather than by this value: if the
 * ledger cannot be reached, `GET /v1/me/balances` answers 503 and no number at all. "We have none"
 * and "we could not fetch them" must never look the same to a client — the same rule
 * `market/src/server.ts:858` states for its risk indicators.
 *
 * `LedgerClient.balances` already refuses an amount that is not `/^-?\d{1,78}$/` before calling
 * `BigInt`, so a malformed figure is dropped rather than becoming `0n` through the back door.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function walletOf(ledger: LedgerClient, subject: string): Promise<Wallet> {
  const balances = await ledger.balances(subject)
  const of = (purpose: string): bigint =>
    balances.find((b) => b.purpose === purpose)?.amount ?? 0n
  return {
    availableWei: of(AVAILABLE),
    reservedWei: of('reserved'),
    payoutDueWei: of(PAYOUT_DUE),
  }
}

/* ------------------------------------------------------------------------- issuing an object */

/**
 * The creator's title to their own object.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN OBJECT MUST BE LEDGER-RESERVABLE BEFORE IT CAN BE SOLD, AND THAT IS SOMEBODY ELSE'S
 * CONSTRAINT.**
 *
 * §8.5's last line: "The one constraint that binds is `listings_active_is_escrowed`
 * (`market/src/migrations.ts:289-293`): an active listing must hold an escrow, so a Tessera object
 * must be ledger-reservable under an `item_asset_code` before it can go live."
 *
 * Market's activation does exactly that — `market/src/listings.ts` `activateListing` calls
 * `holdEscrow` with `kind: 'listing_item'`, `subject: listing.sellerSubject`, `assetCode:
 * listing.itemAssetCode`, `amount: listing.quantity`, moving the item from the seller's
 * `available` to `reserved`. If the creator holds none, the ledger's no-overdraft trigger refuses
 * and the listing cannot activate. So Tessera issues the object to its author FIRST.
 *
 * **`liability`, because the platform owes the creator their object.** The same type and the same
 * `available` purpose `holder()` uses for their EMBER, for the same reason — it is theirs, held
 * custodially.
 *
 * **The counterparty is `clearing`, and it is the only type that may go negative.**
 * `ledger_assert_no_overdraft` returns early for `acct.type = 'clearing'` under the comment "A
 * clearing account nets to zero over a settled period and may legitimately sit either side of zero
 * within one" (`ledger/src/migrations.ts`, the `balances_no_overdraft` trigger). `equity` is NOT
 * exempt, which is the whole of §8.3's safety property for EMBER grants and is exactly why the
 * engagement account cannot be reused here: an issuance account MUST go negative, because the
 * negative is the count of that object in circulation.
 *
 * `clearing` is a SINGLETON subject spelled by the contract (`CLEARING`,
 * `contracts/packages/money/src/index.ts`), not a new one invented here. The account key is
 * `(subject, assetCode, purpose)` and the asset code is unique per object, so `clearing /
 * TOKEN:cf:tessera:object:<hex> / treasury` is a distinct account per object that sits at exactly
 * `-1` once the object is issued. An operator reading `-1` is reading "one of this object exists".
 *
 * **No service in the estate had written a `TOKEN:` balance before this one**, which was verified
 * rather than assumed, and is why every field is cited: there is no prior spelling to match, so
 * this is the one that the next service will have to match. `ledger/src/accounts.ts` throws on a
 * `type` mismatch against an existing account and whichever service posts second has EVERY entry
 * refused.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** One object is one indivisible unit. Not wei — a `TOKEN:` item has no decimals. */
export const ONE_OBJECT = 1n

/** The creator's holding of their own object. `liability`: the platform owes it to them. */
export function objectHolder(subject: string, assetCode: TokenAssetCode): AccountRef {
  const canonical = subject.startsWith('user:')
    ? userSubject(subject.slice('user:'.length))
    : subject
  return { subject: canonical, assetCode, purpose: AVAILABLE, type: 'liability' }
}

/** The issuance counterparty. `clearing`, which is the only type permitted to go negative. */
export function objectIssuer(assetCode: TokenAssetCode): AccountRef {
  return { subject: CLEARING, assetCode, purpose: 'treasury', type: 'clearing' }
}

/**
 * The two postings that bring an object into the ledger.
 *
 * Exported separately from the call so `economy.test.ts` can assert the SHAPE — that the credit
 * side is the AUTHOR and that the debit side is a `clearing` account rather than the `equity` one
 * — without a ledger being up.
 */
export function issuePostings(author: string, assetCode: TokenAssetCode): readonly PostingRequest[] {
  return [
    { account: objectIssuer(assetCode), direction: 'debit', amount: ONE_OBJECT, assetCode, sequence: 0 },
    { account: objectHolder(author, assetCode), direction: 'credit', amount: ONE_OBJECT, assetCode, sequence: 1 },
  ]
}

/**
 * Issue one object to its author.
 *
 * **Idempotent on the object itself**, which is what makes this safe to call on every activation
 * attempt rather than once: the key is derived from the asset code, so a creator who lists,
 * withdraws and relists holds exactly one of their object rather than one per attempt. The ledger
 * answers the second call from its stored response and posts nothing (`market/src/ledgerclient.ts`
 * uses derived keys for the same reason, and `escrow.ts:18-21` calls it the second of three
 * independent defences).
 *
 * There is deliberately no "check the balance first". A check-then-post is a race, and the post is
 * already the check.
 */
export async function issueObjectToAuthor(
  ledger: LedgerClient,
  input: { author: string; assetCode: TokenAssetCode; correlationId: string },
): Promise<{ id: string; replayed: boolean }> {
  return ledger.postEntry({
    kind: 'item_issue',
    actor: 'system',
    correlationId: input.correlationId,
    idempotencyKey: `tessera:issue:${input.assetCode}`,
    postings: issuePostings(input.author, input.assetCode),
    metadata: { programme: SERVICE, itemAssetCode: input.assetCode },
  })
}
