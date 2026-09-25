#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Map, Symbol, Vec};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProposalStatus {
    Active,
    Executed,
    Expired,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub param: Symbol,
    pub value: i128,
    pub votes_for: i128,
    pub votes_against: i128,
    pub voters: Map<Address, i128>,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: ProposalStatus,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum GovernanceError {
    ProposalNotFound = 1,
    VotingClosed = 2,
    AlreadyVoted = 3,
    QuorumNotMet = 4,
    VotingStillActive = 5,
    ProposalNotActive = 6,
    NoVotingPower = 7,
}

const VOTING_PERIOD: u64 = 604_800; // 7 days in seconds
const QUORUM: i128 = 1_000;

#[contract]
pub struct Contract;

#[contractimpl]
impl Contract {
    /// Any user may propose a parameter change. The proposal is recorded with
    /// an expiry (voting period) and starts in the `Active` state.
    pub fn propose_parameter_change(
        env: Env,
        proposer: Address,
        param: Symbol,
        value: i128,
    ) -> u64 {
        proposer.require_auth();

        let mut count: u64 = env
            .storage()
            .instance()
            .get(&symbol_short!("PROP_CNT"))
            .unwrap_or(0);
        count += 1;

        let now = env.ledger().timestamp();
        let proposal = Proposal {
            id: count,
            proposer: proposer.clone(),
            param: param.clone(),
            value,
            votes_for: 0,
            votes_against: 0,
            voters: Map::new(&env),
            created_at: now,
            expires_at: now + VOTING_PERIOD,
            status: ProposalStatus::Active,
        };

        env.storage()
            .persistent()
            .set(&(symbol_short!("PROP"), count), &proposal);
        env.storage().instance().set(&symbol_short!("PROP_CNT"), &count);

        env.events()
            .publish((symbol_short!("ProposalCreated"), count), (proposer, param, value));

        count
    }

    /// Cast a vote weighted by the caller's stake / meter ownership.
    pub fn vote_on_proposal(
        env: Env,
        voter: Address,
        proposal_id: u64,
        support: bool,
    ) -> Result<(), GovernanceError> {
        voter.require_auth();

        let key = (symbol_short!("PROP"), proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }
        if env.ledger().timestamp() >= proposal.expires_at {
            return Err(GovernanceError::VotingClosed);
        }
        if proposal.voters.contains_key(voter.clone()) {
            return Err(GovernanceError::AlreadyVoted);
        }

        let weight = Self::voting_power(&env, &voter);
        if weight <= 0 {
            return Err(GovernanceError::NoVotingPower);
        }

        if support {
            proposal.votes_for += weight;
        } else {
            proposal.votes_against += weight;
        }
        proposal.voters.set(voter.clone(), weight);

        env.storage().persistent().set(&key, &proposal);

        env.events()
            .publish((symbol_short!("VoteCast"), proposal_id), (voter, support, weight));

        Ok(())
    }

    /// Execute a proposal once the voting period has ended and quorum is met.
    pub fn execute_proposal(env: Env, proposal_id: u64) -> Result<(), GovernanceError> {
        let key = (symbol_short!("PROP"), proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(GovernanceError::ProposalNotFound)?;

        if proposal.status != ProposalStatus::Active {
            return Err(GovernanceError::ProposalNotActive);
        }
        if env.ledger().timestamp() < proposal.expires_at {
            return Err(GovernanceError::VotingStillActive);
        }

        let total = proposal.votes_for + proposal.votes_against;
        if total < QUORUM {
            proposal.status = ProposalStatus::Expired;
            env.storage().persistent().set(&key, &proposal);
            return Err(GovernanceError::QuorumNotMet);
        }

        if proposal.votes_for > proposal.votes_against {
            env.storage()
                .instance()
                .set(&proposal.param, &proposal.value);
        }

        proposal.status = ProposalStatus::Executed;
        env.storage().persistent().set(&key, &proposal);

        env.events().publish(
            (symbol_short!("ProposalExecuted"), proposal_id),
            (proposal.param, proposal.value),
        );

        Ok(())
    }

    /// Read a stored proposal.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<Proposal> {
        env.storage()
            .persistent()
            .get(&(symbol_short!("PROP"), proposal_id))
    }

    /// Voting power derived from the voter's stake / meter ownership.
    fn voting_power(env: &Env, voter: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&(symbol_short!("STAKE"), voter.clone()))
            .unwrap_or(0)
    }
}
