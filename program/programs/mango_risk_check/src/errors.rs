use anchor_lang::prelude::*;

#[error_code]
pub enum RiskCheckError {
    #[msg("Number of open orders exceeds requested limit")]
    NumOpenOrdersExceedsRequestedRiskLimit,
    #[msg("Number of open orders exceeds risk limit")]
    NumOpenOrdersExceedsRiskLimit,
    #[msg("Long exposure exceeds requested risk limit")]
    LongExposureExceedsRequestedRiskLimit,
    #[msg("Long exposure exceeds risk limit")]
    LongExposureExceedsRiskLimit,
    #[msg("Short exposure exceeds requested risk limit")]
    ShortExposureExceedsRequestedRiskLimit,
    #[msg("Short exposure exceeds risk limit")]
    ShortExposureExceedsRiskLimit,
    #[msg("Exposure limit must be positive")]
    ExposureLimitMustBePositive
}