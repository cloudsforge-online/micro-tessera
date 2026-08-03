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
  accountKey,
  assertBalanced,
  engagementSubject,
  userSubject,
  type AccountPurpose,
  type AccountType,
  type Actor,
  type LedgerAssetCode,
  type Posting,
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

/**
 * Release a creator's cleared proceeds from `payout_due` to `available`.
 *
 * §8.2: "nothing in Tessera ever debits `payout_due` except the release, and a spend attempt
 * against it would be an overdraft the ledger's `ledger_assert_no_overdraft` trigger refuses."
 *
 * This is the ONLY function in this repository that names `payout_due` as a debit side, and
 * `economy.test.ts` greps the whole source to prove it — because "only the release debits it" is a
 * claim about the repository and no single call site can make it.
 */
export function releasePostings(subject: string, amountWei: bigint): readonly PostingRequest[] {
  return [
    { account: holder(subject, PAYOUT_DUE), direction: 'debit', amount: amountWei, assetCode: ASSET, sequence: 0 },
    { account: holder(subject, AVAILABLE), direction: 'credit', amount: amountWei, assetCode: ASSET, sequence: 1 },
  ]
}

export async function releasePayout(
  ledger: LedgerClient,
  input: { subject: string; amountWei: bigint; idempotencyKey: string; correlationId: string },
): Promise<{ id: string; replayed: boolean }> {
  return ledger.postEntry({
    kind: 'payout',
    actor: 'system',
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    postings: releasePostings(input.subject, input.amountWei),
  })
}
