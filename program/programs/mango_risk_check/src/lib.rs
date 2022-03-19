mod errors;

use std::{cmp};

use anchor_lang::{prelude::*};
use mango::state::{MangoAccount};

use errors::RiskCheckError;

declare_id!("94oHQMrCECP266YUoQmDvgVwafZApP9KAseMyNtjAPP7");

const RISK_PARAMS_ACCOUNT_SEED_PHRASE: &[u8; 10] = b"risk-check";

#[program]
pub mod mango_risk_check {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, market_index: u8) -> Result<()> {
        let risk_params_account = &mut ctx.accounts.risk_params_account;
        risk_params_account.authority = ctx.accounts.authority.key();
        risk_params_account.bump = *ctx.bumps.get("risk_params_account").unwrap();
        // TODO: Verify this is a real symbol
        risk_params_account.market_index = market_index;

        // Default risk parameters are set to most permissive
        risk_params_account.max_long_exposure = i64::MAX;
        risk_params_account.max_short_exposure = i64::MAX;
        risk_params_account.max_open_orders = u64::MAX;
        risk_params_account.max_capital_allocated = u64::MAX;
        risk_params_account.violation_behaviour = ViolationBehaviour::RejectTransaction;
        Ok(())
    }

    pub fn set_max_open_orders(ctx: Context<SetRiskParams>, max_open_orders: u64) -> Result<()> {
        let risk_values = get_risk_values(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            &ctx.accounts.mango_account,
            ctx.accounts.risk_params_account.market_index
        );
        let num_open_orders = risk_values.num_open_orders;
        if num_open_orders > max_open_orders {
            return Err(RiskCheckError::NumOpenOrdersExceedsRequestedRiskLimit.into());
        }
        ctx.accounts.risk_params_account.max_open_orders = max_open_orders;
        Ok(())
    }

    pub fn set_max_long_exposure(ctx: Context<SetRiskParams>, max_long_exposure: i64) -> Result<()> {
        if max_long_exposure < 0 {
            return Err(RiskCheckError::ExposureLimitMustBePositive.into());
        }
        let risk_values = get_risk_values(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            &ctx.accounts.mango_account,
            ctx.accounts.risk_params_account.market_index
        );
        let long_exposure = risk_values.long_exposure;
        if long_exposure > max_long_exposure {
            return Err(RiskCheckError::LongExposureExceedsRequestedRiskLimit.into());
        }
        ctx.accounts.risk_params_account.max_long_exposure = max_long_exposure;
        Ok(())
    }

    pub fn set_max_short_exposure(ctx: Context<SetRiskParams>, max_short_exposure: i64) -> Result<()> {
        if max_short_exposure < 0 {
            return Err(RiskCheckError::ExposureLimitMustBePositive.into());
        }
        let risk_values = get_risk_values(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            &ctx.accounts.mango_account,
            ctx.accounts.risk_params_account.market_index
        );
        let short_exposure = risk_values.short_exposure;
        if short_exposure > max_short_exposure {
            return Err(RiskCheckError::ShortExposureExceedsRequestedRiskLimit.into());
        }
        ctx.accounts.risk_params_account.max_short_exposure = max_short_exposure;
        Ok(())
    }

    pub fn set_violation_behaviour(ctx: Context<SetRiskParams>, violation_behaviour: ViolationBehaviour) -> Result<()> {
        ctx.accounts.risk_params_account.violation_behaviour = violation_behaviour;
        Ok(())
    }

    pub fn close(_ctx: Context<Close>) -> Result<()> {
        Ok(())
    }

    pub fn check_risk(ctx: Context<CheckRisk>) -> Result<()> {
        let RiskValues { 
            position,
            unconsumed_position,
            num_open_orders,
            long_order_quantity,
            short_order_quantity,
            long_exposure,
            short_exposure
        } = get_risk_values(
            ctx.accounts.mango_program.key,
            ctx.accounts.mango_group.key,
            &ctx.accounts.mango_account,
            ctx.accounts.risk_params_account.market_index
        );
        let has_orders = (long_order_quantity + short_order_quantity) > 0;

        // Check open orders
        if num_open_orders > ctx.accounts.risk_params_account.max_open_orders {
            msg!("Open orders exceeded: num_open_orders: {}, risk_limit: {}",
                num_open_orders,ctx.accounts.risk_params_account.max_open_orders
            );
            match ctx.accounts.risk_params_account.violation_behaviour {
                ViolationBehaviour::RejectTransaction => return Err(RiskCheckError::NumOpenOrdersExceedsRiskLimit.into()),
                ViolationBehaviour::CancelAllOrders => {
                    if has_orders {
                        cancel_all(&ctx);
                    }
                    return Ok(());
                }
            }
        }

        // Check long exposure
        let max_long_exposure = ctx.accounts.risk_params_account.max_long_exposure;
        if long_exposure > max_long_exposure {
            msg!("Long exposure exceeded: position: {}, unconsumed_position: {}, long_order_qty: {}, long_exposure: {}, risk_limit: {}",
                position,unconsumed_position,long_order_quantity,long_exposure,ctx.accounts.risk_params_account.max_long_exposure
            );
            match ctx.accounts.risk_params_account.violation_behaviour {
                ViolationBehaviour::RejectTransaction => return Err(RiskCheckError::LongExposureExceedsRiskLimit.into()),
                ViolationBehaviour::CancelAllOrders => {
                    // Will cancelling orders get us below the risk limit?
                    if (long_exposure - long_order_quantity) < max_long_exposure {
                        cancel_all(&ctx);
                        return Ok(());
                    } else {
                        return Err(RiskCheckError::LongExposureExceedsRiskLimit.into())
                    }
                }
            }
        }

        // Check short exposure
        let max_short_exposure = ctx.accounts.risk_params_account.max_short_exposure;
        if short_exposure > max_short_exposure {
            msg!("Short exposure exceeded: position: {}, unconsumed_position: {}, short_order_qty: {}, short_exposure: {}, risk_limit: {}",
                position,unconsumed_position,short_order_quantity,short_exposure,ctx.accounts.risk_params_account.max_short_exposure
            );
            match ctx.accounts.risk_params_account.violation_behaviour {
                ViolationBehaviour::RejectTransaction => return Err(RiskCheckError::ShortExposureExceedsRiskLimit.into()),
                ViolationBehaviour::CancelAllOrders => {
                    // Will cancelling orders get us below the risk limit?
                    if (short_exposure - short_order_quantity) < max_short_exposure {
                        cancel_all(&ctx);
                        return Ok(());
                    } else {
                        return Err(RiskCheckError::LongExposureExceedsRiskLimit.into())
                    }
                }
            }
        }

        Ok(())
    }
}

pub struct RiskValues {
    position: i64,
    unconsumed_position: i64,
    long_order_quantity: i64,
    short_order_quantity: i64,
    num_open_orders: u64,
    long_exposure: i64,
    short_exposure: i64
}

pub fn get_risk_values(mango_program_id: &Pubkey, mango_group_id: &Pubkey, mango_acount_info: &AccountInfo, market_index: u8) -> RiskValues {
    let mango_account = MangoAccount::load_checked(
        mango_acount_info,
        &mango_program_id,
        &mango_group_id
    ).unwrap();

    // TODO: Consume events to make sure we always have latest position?

    let perp_account = mango_account.perp_accounts[market_index as usize];
    let num_open_orders: u64 = mango_account.order_market.into_iter()
        .filter(|o| *o == market_index)
        .count()
        .try_into()
        .unwrap();

    let position: i64 = perp_account.base_position;
    let unconsumed_position: i64 = perp_account.taker_base; // Position that has not yet been consumed from event queue
    let long_order_quantity: i64 = perp_account.bids_quantity;  // This should never be negative
    let short_order_quantity: i64 = perp_account.asks_quantity; // This should never be negative
    let long_exposure: i64 = cmp::max(0,position
                                                .checked_add(unconsumed_position)
                                                .unwrap()
                                                .checked_add(long_order_quantity)
                                                .unwrap());
    let short_exposure: i64 = cmp::max(0,position
                                                .checked_add(unconsumed_position)
                                                .unwrap()
                                                .checked_sub(short_order_quantity)
                                                .unwrap()
                                                .checked_mul(-1)
                                                .unwrap());

    return RiskValues {
        position,
        unconsumed_position,
        num_open_orders,
        long_order_quantity,
        short_order_quantity,
        long_exposure,
        short_exposure
    }
}

pub fn cancel_all(ctx: &Context<CheckRisk>) {
    let ix = mango::instruction::cancel_all_perp_orders(
        ctx.accounts.mango_program.key,
        ctx.accounts.mango_group.key,
        ctx.accounts.mango_account.key,
        ctx.accounts.authority.key,
        ctx.accounts.perp_market.key,
        ctx.accounts.perp_market_bids.key,
        ctx.accounts.perp_market_asks.key,
        20).unwrap();
    let account_infos = [
        ctx.accounts.mango_program.clone(),
        ctx.accounts.mango_group.clone(),
        ctx.accounts.mango_account.clone(),
        ctx.accounts.authority.to_account_info(),
        ctx.accounts.perp_market.clone(),
        ctx.accounts.perp_market_bids.clone(),
        ctx.accounts.perp_market_asks.clone(),
    ];
    solana_program::program::invoke(&ix, &account_infos).unwrap();
}

#[derive(AnchorSerialize,AnchorDeserialize,Clone,Copy)]
#[repr(u8)]
pub enum ViolationBehaviour {
    RejectTransaction = 0,
    CancelAllOrders = 1
}

impl Default for ViolationBehaviour {
    fn default() -> Self {
        return ViolationBehaviour::RejectTransaction;
    }
}

#[account]
#[derive(Default)]
pub struct RiskParamsAccount {
    pub authority: Pubkey, // 32
    pub bump: u8, // 1
    pub market_index: u8, // 1

    pub max_long_exposure: i64, // 8
    pub max_short_exposure: i64, // 8
    pub max_open_orders: u64, // 8
    pub max_capital_allocated: u64, // 8

    pub violation_behaviour: ViolationBehaviour // 1
}

#[derive(Accounts)]
#[instruction(market_index: u8)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        seeds = [RISK_PARAMS_ACCOUNT_SEED_PHRASE, [market_index].as_ref(), authority.key().as_ref()],
        bump
    )]
    pub risk_params_account: Account<'info, RiskParamsAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Close<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        close = authority
    )]
    pub risk_params_account: Account<'info, RiskParamsAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRiskParams<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        has_one = authority,
        seeds = [RISK_PARAMS_ACCOUNT_SEED_PHRASE, [risk_params_account.market_index].as_ref(), authority.key().as_ref()],
        bump = risk_params_account.bump
    )]
    pub risk_params_account: Account<'info, RiskParamsAccount>,
    /// CHECK: read-only
    pub mango_program: AccountInfo<'info>,
    /// CHECK: read-only
    pub mango_account: AccountInfo<'info>,
    /// CHECK: read-only
    pub mango_group: AccountInfo<'info>
}

#[derive(Accounts)]
pub struct CheckRisk<'info> {
    pub authority: Signer<'info>,
    #[account(
        has_one = authority,
        seeds = [RISK_PARAMS_ACCOUNT_SEED_PHRASE, [risk_params_account.market_index].as_ref(), authority.key().as_ref()],
        bump = risk_params_account.bump
    )]
    pub risk_params_account: Account<'info, RiskParamsAccount>,
    /// CHECK: read-only
    pub mango_program: AccountInfo<'info>,
    /// CHECK: read-only
    pub mango_account: AccountInfo<'info>,
    /// CHECK: read-only
    pub mango_group: AccountInfo<'info>,
    /// CHECK: read-only
    pub perp_market: AccountInfo<'info>,
    /// CHECK: read-only
    pub perp_market_bids: AccountInfo<'info>,
    /// CHECK: read-only
    pub perp_market_asks: AccountInfo<'info>
}