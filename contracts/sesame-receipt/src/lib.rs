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
    Custodian(Address),
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
    /// Initialise the contract. May only be called once.
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

    /// Authorizes and grants minting privileges to a licensed warehouse custodian.
    pub fn add_custodian(env: Env, admin: Address, custodian: Address) -> Result<(), ContractError> {
        admin.require_auth();
        
        let saved_admin: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;
            
        if admin != saved_admin {
            return Err(ContractError::Unauthorized);
        }

        env.storage().instance().set(&DataKey::Custodian(custodian), &true);
        Ok(())
    }

    /// Authorizes and revokes minting privileges from a warehouse custodian.
    pub fn remove_custodian(env: Env, admin: Address, custodian: Address) -> Result<(), ContractError> {
        admin.require_auth();

        let saved_admin: Address = env.storage().instance().get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;
            
        if admin != saved_admin {
            return Err(ContractError::Unauthorized);
        }

        env.storage().instance().remove(&DataKey::Custodian(custodian));
        Ok(())
    }

    /// Mints a unique Sesame Warehouse Receipt token.
    /// Rejects any commodity variation that isn't exactly "SESAME".
    /// Formats token ID as: SE-2026-NNNNNN
    pub fn mint(
        env:               Env,
        custodian:         Address,
        farmer_wallet:     Address,
        commodity:         String,
        grade:             String,
        bag_count:         u32,
        weight_per_bag_kg: u32,
        warehouse_id:      String,
    ) -> Result<String, ContractError> {
        custodian.require_auth();

        // 1. Verify caller is an authorized custodian
        if !env.storage().instance().has(&DataKey::Custodian(custodian.clone())) {
            return Err(ContractError::Unauthorized);
        }

        // 2. Strict commodity validation
        let expected_commodity = String::from_str(&env, "SESAME");
        if commodity != expected_commodity {
            return Err(ContractError::InvalidCommodity);
        }

        // 3. Counter incrementation
        let mut current_counter: u64 = env.storage().instance().get(&DataKey::TokenCounter).unwrap_or(0);
        current_counter += 1;
        env.storage().instance().set(&DataKey::TokenCounter, &current_counter);

        // 4. Safe padding logic using fixed-size byte buffers entirely on the stack (No global allocator needed)
        let mut id_bytes = [0u8; 14]; // Length of "SE-2026-000000" is exactly 14 characters
        id_bytes[0..8].copy_from_slice(b"SE-2026-");

        let mut temp = current_counter;
        for i in (8..14).rev() {
            let digit = (temp % 10) as u8;
            id_bytes[i] = b'0' + digit;
            temp /= 10;
        }

        // Create the Soroban environment SDK String safely from bytes
        let token_id = String::from_str(&env, core::str::from_utf8(&id_bytes).unwrap_or(""));

        // 5. Structure & Commit the state modifications
        let total_weight_kg = bag_count * weight_per_bag_kg;
        let deposit_ts = env.ledger().timestamp();

        let metadata = TokenMetadata {
            token_id: token_id.clone(),
            commodity,
            grade,
            bag_count,
            weight_per_bag_kg,
            total_weight_kg,
            warehouse_id,
            custodian,
            deposit_ts,
            is_locked: false,
        };

        env.storage().instance().set(&DataKey::TokenMeta(token_id.clone()), &metadata);
        env.storage().instance().set(&DataKey::Owner(token_id.clone()), &farmer_wallet);

        Ok(token_id)
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

        let _admin         = DataKey::Admin.clone();
        let _custodian     = DataKey::Custodian(Address::generate(&env));
        let _token_meta    = DataKey::TokenMeta(String::from_str(&env, "token_id"));
        let _owner         = DataKey::Owner(String::from_str(&env, "token_id"));
        let _token_counter = DataKey::TokenCounter.clone();
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
    // Custodian Management Tests
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_add_custodian_success() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let custodian = Address::generate(&env);

        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let has_custodian = env.as_contract(&contract_id, || {
            env.storage().instance().has(&DataKey::Custodian(custodian))
        });
        assert!(has_custodian);
    }

    #[test]
    fn sesame_test_add_custodian_unauthorized() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin      = Address::generate(&env);
        let fake_admin = Address::generate(&env);
        let custodian  = Address::generate(&env);

        client.init(&admin);
        let result = client.try_add_custodian(&fake_admin, &custodian);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn sesame_test_remove_custodian_success() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let custodian = Address::generate(&env);

        client.init(&admin);
        client.add_custodian(&admin, &custodian);
        client.remove_custodian(&admin, &custodian);

        let has_custodian = env.as_contract(&contract_id, || {
            env.storage().instance().has(&DataKey::Custodian(custodian))
        });
        assert!(!has_custodian);
    }

    // -----------------------------------------------------------------------
    // Minting Functionality & Edge Case Verification
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_mint_rejects_invalid_commodity() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer    = Address::generate(&env);

        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let invalid_commodity = String::from_str(&env, "MAIZE_WHITE");
        let dummy = String::from_str(&env, "DUMMY");

        let result = client.try_mint(
            &custodian,
            &farmer,
            &invalid_commodity,
            &dummy,
            &100,
            &50,
            &dummy
        );

        assert_eq!(result, Err(Ok(ContractError::InvalidCommodity)));
    }

    #[test]
    fn sesame_test_mint_success() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer    = Address::generate(&env);

        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let commodity = String::from_str(&env, "SESAME");
        let grade     = String::from_str(&env, "Grade A");
        let wh_id     = String::from_str(&env, "WH-01");

        let token_id = client.mint(
            &custodian,
            &farmer,
            &commodity,
            &grade,
            &200,
            &50,
            &wh_id
        );

        assert_eq!(token_id, String::from_str(&env, "SE-2026-000001"));
    }

    #[test]
    fn sesame_test_mint_counter_increments() {
        let env         = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);

        let admin     = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer    = Address::generate(&env);

        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let commodity = String::from_str(&env, "SESAME");
        let grade     = String::from_str(&env, "Grade A");
        let wh_id     = String::from_str(&env, "WH-01");

        let token_id_1 = client.mint(&custodian, &farmer, &commodity, &grade, &100, &50, &wh_id);
        let token_id_2 = client.mint(&custodian, &farmer, &commodity, &grade, &100, &50, &wh_id);

        assert_eq!(token_id_1, String::from_str(&env, "SE-2026-000001"));
        assert_eq!(token_id_2, String::from_str(&env, "SE-2026-000002"));
    }

    #[test]
    fn sesame_test_commodity_accepts_only_sesame() {
        let env = Env::default();

        let valid                = String::from_str(&env, "SESAME");
        let invalid_maize_white  = String::from_str(&env, "MAIZE_WHITE");
        let invalid_maize_yellow = String::from_str(&env, "MAIZE_YELLOW");
        let invalid_wheat        = String::from_str(&env, "WHEAT");
        let invalid_empty        = String::from_str(&env, "");

        let accepts = |c: &String| -> bool { *c == valid };

        assert!( accepts(&valid),                "SESAME must be accepted");
        assert!(!accepts(&invalid_maize_white),  "MAIZE_WHITE must be rejected");
        assert!(!accepts(&invalid_maize_yellow), "MAIZE_YELLOW must be rejected");
        assert!(!accepts(&invalid_wheat),        "WHEAT must be rejected");
        assert!(!accepts(&invalid_empty),        "empty string must be rejected");
    }

    #[test]
    fn sesame_test_version() {
        let env         = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client      = SesameReceiptContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), String::from_str(&env, "0.1.0"));
    }
}