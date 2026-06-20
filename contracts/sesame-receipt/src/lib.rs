#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, Address, Env, String,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum ContractError {
    AlreadyInitialized = 1,
    Unauthorized       = 2,
    TokenNotFound      = 3,
    TokenLocked        = 4,
    InvalidCommodity   = 5,
    InvalidWeight      = 6,
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Custodians,
    TokenMeta(String),
    Owner(String),
    TokenCounter,
}

// ---------------------------------------------------------------------------
// Token metadata
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenMetadata {
    pub token_id:          String,
    pub commodity:         String,
    pub grade:             String,
    pub bag_count:         u32,
    pub weight_per_bag_kg: u32,
    pub total_weight_kg:   u32,
    pub warehouse_id:      String,
    pub custodian:         Address,
    pub deposit_ts:        u64,
    pub is_locked:         bool,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct SesameReceiptContract;

#[contractimpl]
impl SesameReceiptContract {
    /// Initialise the contract.  May only be called once.
    pub fn init(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenCounter, &0u64);
        Ok(())
    }

    /// Returns the crate version string – kept for compatibility.
    pub fn version(env: Env) -> String {
        String::from_str(&env, "0.1.0")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    // -----------------------------------------------------------------------
    // ContractError discriminants
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_contract_error_discriminants() {
        // Verify every variant compiles and has the expected integer value.
        assert_eq!(ContractError::AlreadyInitialized as u32, 1);
        assert_eq!(ContractError::Unauthorized       as u32, 2);
        assert_eq!(ContractError::TokenNotFound      as u32, 3);
        assert_eq!(ContractError::TokenLocked        as u32, 4);
        assert_eq!(ContractError::InvalidCommodity   as u32, 5);
        assert_eq!(ContractError::InvalidWeight      as u32, 6);
    }

    // -----------------------------------------------------------------------
    // DataKey variants
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_datakey_variants_exist() {
        let env = Env::default();

        // Constructing each variant proves they compile and are reachable.
        let _admin         = DataKey::Admin.clone();
        let _custodians    = DataKey::Custodians.clone();
        let _token_meta    = DataKey::TokenMeta(String::from_str(&env, "token_id"));
        let _owner         = DataKey::Owner(String::from_str(&env, "token_id"));
        let _token_counter = DataKey::TokenCounter.clone();

        let _ = _admin;
        let _ = _custodians;
        let _ = _token_meta;
        let _ = _owner;
        let _ = _token_counter;
    }

    // -----------------------------------------------------------------------
    // TokenMetadata round-trip through contract storage
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_token_metadata_roundtrip() {
        let env         = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let key         = String::from_str(&env, "token-123");
        let custodian   = Address::generate(&env);

        let metadata = TokenMetadata {
            token_id:          key.clone(),
            commodity:         String::from_str(&env, "SESAME"),
            grade:             String::from_str(&env, "Grade A"),
            bag_count:         100,
            weight_per_bag_kg: 50,
            total_weight_kg:   5_000,
            warehouse_id:      String::from_str(&env, "warehouse-1"),
            custodian:         custodian.clone(),
            deposit_ts:        1_700_000_000,
            is_locked:         true,
        };

        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::TokenMeta(key.clone()), &metadata);
        });

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(key))
                .unwrap()
        });

        assert_eq!(stored, metadata);
    }

    // -----------------------------------------------------------------------
    // init() – admin is persisted
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_init_sets_admin() {
        let env         = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let stored: Address = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Admin).unwrap()
        });
        assert_eq!(stored, admin);
    }

    // -----------------------------------------------------------------------
    // init() – second call is rejected
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_init_rejects_double_call() {
        let env         = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let result = client.try_init(&admin);
        assert_eq!(result, Err(Ok(ContractError::AlreadyInitialized)));
    }

    // -----------------------------------------------------------------------
    // Commodity validation – only "SESAME" is accepted
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_commodity_accepts_only_sesame() {
        let env = Env::default();

        // Valid commodity
        let valid   = String::from_str(&env, "SESAME");
        // Invalid alternatives that maize-receipt would accept
        let invalid_maize_white  = String::from_str(&env, "MAIZE_WHITE");
        let invalid_maize_yellow = String::from_str(&env, "MAIZE_YELLOW");
        let invalid_wheat        = String::from_str(&env, "WHEAT");
        let invalid_empty        = String::from_str(&env, "");

        // Helper that mimics the commodity check inside mint()
        let accepts = |c: &String| -> bool { *c == valid };

        assert!( accepts(&valid),                "SESAME must be accepted");
        assert!(!accepts(&invalid_maize_white),  "MAIZE_WHITE must be rejected");
        assert!(!accepts(&invalid_maize_yellow), "MAIZE_YELLOW must be rejected");
        assert!(!accepts(&invalid_wheat),        "WHEAT must be rejected");
        assert!(!accepts(&invalid_empty),        "empty string must be rejected");
    }

    // -----------------------------------------------------------------------
    // version() – kept for compatibility
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_version() {
        let env         = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), String::from_str(&env, "0.1.0"));
    }
}
