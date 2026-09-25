# SolarGrid Smart Contract

## Event Schema

The contract emits Soroban events for real-time monitoring by backend and frontend systems.

### Event Topics

All events use the namespace `solargrid` (EVT_NS) as the second topic.

#### meter_registered
- **Topic 0:** `mtr_reg` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `owner` (Address)

Emitted when a new meter is registered.

#### payment_received
- **Topic 0:** `pmt_rcvd` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `(payer: Address, token_address: Address, amount: i128, plan: PaymentPlan)`

Emitted when a payment is made to top up a meter's balance.

#### meter_activated
- **Topic 0:** `mtr_actv` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter is activated (via `make_payment` or `set_active(true)`).

#### usage_updated
- **Topic 0:** `usg_upd` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `(units: u64, cost: i128)`

Emitted when energy usage is recorded and cost deducted from balance.

#### meter_deactivated
- **Topic 0:** `mtr_deact` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (String)
- **Data:** `MeterDeactivated` (`meter_id: String`, `reason: Symbol`, `timestamp: u64`)

Emitted when a meter is deactivated in any of the following scenarios:
- Balance depleted to zero (`balance_zero`) in `apply_usage()` or refund
- Administrative deactivation (`admin_action`) via `set_active(false)`, `set_meter_active(false)`, `deactivate_meter()`, or `batch_deactivate_meters()`
- Grace period expiry (`expiry`) in `apply_usage()`

#### batch_skip
- **Topic 0:** `btch_skip` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `meter_id` (Symbol)
- **Data:** `()` (empty)

Emitted when a meter ID in `batch_update_usage` is not found and skipped.
Also emitted (with the same shape) by `batch_register_meters` for each entry
skipped because the meter ID already exists, is duplicated within the batch,
or the owner is not on the allowlist.
Also emitted by `batch_deactivate_meters` for each meter that is not found
or already inactive.

#### revenue_withdrawn
- **Topic 0:** `rev_wdrl` (symbol_short)
- **Topic 1:** `solargrid` (EVT_NS)
- **Topic 2:** `provider` (Address)
- **Data:** `(token_address: Address, amount: i128)`

Emitted when the provider withdraws accumulated revenue.

#### meter_transferred (MeterTransferred)
- **Topic 0:** `solargrid` (EVT_NS)
- **Topic 1:** `MeterTransferred`
- **Topic 2:** `meter_id` (String)
- **Data:** `(old_owner: Address, new_owner: Address, meter_id: String)`

Emitted when meter ownership is transferred via `transfer_meter(meter_id, new_owner)`. Updates `OwnerMeters` index for both old and new owners, resets `units_used` for the new owner, and requires authorization from the current owner or admin.

#### discount_created / discount_revoked / discount_applied

Closes #687 — promotional discount codes.

- `discount_created` — topics `(solargrid, disc_new, code: String)`, data `(discount_pct: u32, valid_until: u64, max_uses: u32)`. Emitted by `admin_create_discount`.
- `discount_revoked` — topics `(solargrid, disc_rvk, code: String)`, no data. Emitted by `admin_revoke_discount`.
- `discount_applied` — topics `(solargrid, disc_appl, code: String)`, data `(meter_id: String, amount: i128, final_cost: i128, discount_pct: u32)`. Emitted by `make_payment_with_discount`.

#### withdrawal_announced / emergency_withdrawal / withdrawal_cancelled

Closes #686 — timelocked emergency admin withdrawal. `emergency_withdraw(amount, recipient)` is a two-step call: the first call announces (starts a 48h timelock), and calling again with the same `amount`/`recipient` after the timelock elapses executes the transfer.

- `withdrawal_announced` — topics `(solargrid, wd_ann)`, data `(recipient: Address, amount: i128, announced_at: u64)`. Emitted on the announcing call.
- `emergency_withdrawal` — topics `(solargrid, emrg_wd)`, data `(recipient: Address, amount: i128)`. Emitted on the executing call, once the 48h timelock has elapsed. `amount` here is the actual amount transferred, capped at the contract's token balance.
- `withdrawal_cancelled` — topics `(solargrid, wd_cncl)`, no data. Emitted by `cancel_emergency_withdrawal`.

`emergency_withdraw` requires the contract to be frozen (`freeze_contract`) and caps `amount` at `TOTAL_REVENUE` — cumulative gross revenue ever collected via `make_payment`/`make_payment_with_discount` — so a compromised admin key can't drain more than customers have actually paid in, regardless of the contract's raw token balance.

#### proposal_created / vote_cast / proposal_executed

Closes #845 — community governance for contract parameter changes. Any user may open a proposal to change a governed parameter; voting weight is derived from stake or meter ownership; execution is only possible after the voting period ends and the quorum is met.

- `proposal_created` — topics `(solargrid, prop_new, proposal_id: u64)`, data `(proposer: Address, param: Symbol, new_value: i128, voting_ends_at: u64, expires_at: u64)`. Emitted by `propose_parameter_change`.
- `vote_cast` — topics `(solargrid, vote_cast, proposal_id: u64)`, data `(voter: Address, weight: i128, in_favor: bool)`. Emitted by `vote_on_proposal`.
- `proposal_executed` — topics `(solargrid, prop_exec, proposal_id: u64)`, data `(param: Symbol, new_value: i128)`. Emitted by `execute_proposal` once the voting period has ended and quorum is satisfied.

Governance flow:
1. `propose_parameter_change(proposer, param, new_value)` — any user can propose. Records `voting_ends_at` (voting period) and `expires_at` (proposal expiry).
2. `vote_on_proposal(voter, proposal_id, in_favor)` — weighted by the voter's stake or meter ownership. Rejected after `voting_ends_at` or `expires_at`.
3. `execute_proposal(proposal_id)` — callable only after `voting_ends_at`; requires the quorum to be met and the proposal not to have expired. Applies the parameter change and emits `proposal_executed`.

Proposals that reach `expires_at` without execution are no longer executable.

## Backend Event Listener

The backend can subscribe to these events via the Stellar RPC `getEvents` endpoint:

```javascript
// Example: Listen for payment_received events
const events = await rpc.getEvents({
  filters: [
    {
      type: 'contract',
      contractIds: [CONTRACT_ID],
      topics: [['pmt_rcvd', 'solargrid']]
    }
  ]
});
```

## Testing

All event emissions are covered by unit tests:
- `test_event_meter_registered`
- `test_event_payment_received_and_meter_activated`
- `test_event_usage_updated_and_meter_deactivated`
- `test_event_meter_deactivated_via_set_active`
- `test_event_meter_activated_via_set_active`
- `test_batch_update_usage_skips_invalid_meter` (includes batch_skip event)
- `test_emergency_withdraw_announce_then_execute_after_timelock`, `test_emergency_withdraw_requires_frozen`, `test_emergency_withdraw_capped_at_total_revenue`, `test_emergency_withdraw_capped_at_current_balance_if_lower`, `test_cancel_emergency_withdrawal`, `test_emergency_withdraw_reannounce_restarts_timelock` (issue #686)
- `test_admin_create_and_get_discount`, `test_make_payment_with_discount_applies_percent_off`, `test_make_payment_with_discount_respects_max_uses`, `test_make_payment_with_discount_respects_expiry`, `test_admin_revoke_discount` (issue #687)
- `test_propose_parameter_change_any_user`, `test_vote_on_proposal_weighted_by_stake`, `test_execute_proposal_after_voting_period`, `test_execute_proposal_requires_quorum`, `test_execute_proposal_rejected_before_voting_ends`, `test_proposal_expires` (issue #845)

**Note:** the crate's test module currently fails to compile on `main` for reasons unrelated to these two features (many pre-existing tests pass a `Symbol` where the `meter_id: String` parameters now expect a `String`, plus a `ContractEvents::iter` API drift) — `cargo test` cannot run for this crate until that's fixed. The new code above was verified with `cargo check` (library) and `cargo build --target wasm32v1-none --release` (both clean), and its own test functions were confirmed to produce zero compiler errors by cross-referencing `cargo check --tests` output against their line ranges.

### Batch Deactivate Tests (Issue #664)
- `test_batch_deactivate_all_active` — deactivates 3 active meters in one call
- `test_batch_deactivate_skips_inactive` — skips already-inactive meters
- `test_batch_deactivate_skips_nonexistent` — skips meters that don't exist
- `test_batch_deactivate_mixed` — mix of active, inactive, and nonexistent
- `test_batch_deactivate_empty` — empty vector returns zero counts
- `test_batch_deactivate_too_large` — rejects batches over 50 entries
- `test_batch_deactivate_emits_events` — verifies mtr_deact events

### Bulk Meter Registration (Issue #818)
The `batch_register_meters(meters: Vec<(String, Address)>)` function enables energy providers to register up to 50 meters in a single transaction:
- **Max Batch Size:** 50 meters per call. Returns `ContractError::BatchTooLarge` if exceeded.
- **Input Validation:** Pre-validates empty meter IDs, duplicate IDs in batch, existing meters, and owner allowlist membership.
- **Event Emission:** Emits standard `meter_registered` (`mtr_reg`) event for each successfully registered meter and `batch_skip` (`btch_skip`) for failed/skipped entries.
- **Detailed Error Reporting:** Returns `Vec<BatchRegisterResult>` with `meter_id`, `success: bool`, and `error: Option<String>` detailing reasons for any partial failures (`empty_meter_id`, `duplicate_in_batch`, `meter_alre

/* … truncated 4604 chars — edit only what you need near the top … */
