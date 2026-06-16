#![no_std]
use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    Unauthorized = 2,
    TokenNotFound = 3,
    TokenLocked = 4,
    InvalidCommodity = 5,
    InvalidWeight = 6,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_contract_error_discriminants() {
        assert_eq!(ContractError::AlreadyInitialized as u32, 1);
        assert_eq!(ContractError::Unauthorized as u32, 2);
        assert_eq!(ContractError::TokenNotFound as u32, 3);
        assert_eq!(ContractError::TokenLocked as u32, 4);
        assert_eq!(ContractError::InvalidCommodity as u32, 5);
        assert_eq!(ContractError::InvalidWeight as u32, 6);
    }
}
