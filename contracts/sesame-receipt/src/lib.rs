#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracterror, contracttype, symbol_short, Address, Env, String,
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

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
    pub token_id: String,
    pub commodity: String,
    pub grade: String,
    pub bag_count: u32,
    pub weight_per_bag_kg: u32,
    pub total_weight_kg: u32,
    pub warehouse_id: String,
    pub custodian: Address,
    pub deposit_ts: u64,
    pub is_locked: bool,
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

    // -----------------------------------------------------------------------
    // Custodian management
    // -----------------------------------------------------------------------

    pub fn add_custodian(
        env: Env,
        admin: Address,
        custodian: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        env.storage()
            .instance()
            .set(&DataKey::Custodian(custodian), &true);

        Ok(())
    }

    pub fn remove_custodian(
        env: Env,
        admin: Address,
        custodian: Address,
    ) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        env.storage()
            .instance()
            .remove(&DataKey::Custodian(custodian));

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Mint
    // -----------------------------------------------------------------------

    pub fn mint(
        env: Env,
        custodian: Address,
        farmer_wallet: Address,
        commodity: String,
        grade: String,
        bag_count: u32,
        weight_per_bag_kg: u32,
        warehouse_id: String,
    ) -> Result<String, ContractError> {
        custodian.require_auth();

        if !env.storage().instance().has(&DataKey::Custodian(custodian.clone())) {
            return Err(ContractError::Unauthorized);
        }

        let sesame = String::from_str(&env, "SESAME");
        if commodity != sesame {
            return Err(ContractError::InvalidCommodity);
        }

        if bag_count == 0 {
            return Err(ContractError::InvalidWeight);
        }

        if weight_per_bag_kg == 0 {
            return Err(ContractError::InvalidWeight);
        }

        let counter: u64 = env
            .storage()
            .instance()
            .get(&DataKey::TokenCounter)
            .unwrap_or(0)
            + 1;
        env.storage()
            .instance()
            .set(&DataKey::TokenCounter, &counter);

        let year = year_from_timestamp(env.ledger().timestamp());
        let token_id = generate_token_id(&env, year, counter);

        let total_weight_kg = bag_count
            .checked_mul(weight_per_bag_kg)
            .ok_or(ContractError::InvalidWeight)?;

        let metadata = TokenMetadata {
            token_id: token_id.clone(),
            commodity,
            grade,
            bag_count,
            weight_per_bag_kg,
            total_weight_kg,
            warehouse_id: warehouse_id.clone(),
            custodian: custodian.clone(),
            deposit_ts: env.ledger().timestamp(),
            is_locked: false,
        };

        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(token_id.clone()), &metadata);
        env.storage()
            .instance()
            .set(&DataKey::Owner(token_id.clone()), &farmer_wallet);

        env.events().publish(
            (symbol_short!("Deposit"), custodian.clone()),
            (
                token_id.clone(),
                farmer_wallet.clone(),
                warehouse_id,
                bag_count,
                weight_per_bag_kg,
            ),
        );

        Ok(token_id)
    }

    // -----------------------------------------------------------------------
    // Transfer
    // -----------------------------------------------------------------------

    pub fn transfer(
        env: Env,
        token_id: String,
        from: Address,
        to: Address,
    ) -> Result<(), ContractError> {
        let metadata: TokenMetadata = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

        let owner: Address = env
            .storage()
            .instance()
            .get(&DataKey::Owner(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

        if owner != from {
            return Err(ContractError::Unauthorized);
        }

        if metadata.is_locked {
            return Err(ContractError::TokenLocked);
        }

        from.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::Owner(token_id.clone()), &to);

        env.events().publish(
            (symbol_short!("Transfer"), from.clone()),
            (token_id.clone(), to.clone()),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Burn
    // -----------------------------------------------------------------------

    pub fn burn(env: Env, custodian: Address, token_id: String) -> Result<(), ContractError> {
        let metadata: TokenMetadata = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

        if metadata.is_locked {
            return Err(ContractError::TokenLocked);
        }

        if metadata.custodian != custodian {
            return Err(ContractError::Unauthorized);
        }

        custodian.require_auth();

        env.storage()
            .instance()
            .remove(&DataKey::TokenMeta(token_id.clone()));
        env.storage()
            .instance()
            .remove(&DataKey::Owner(token_id.clone()));

        env.events().publish(
            (symbol_short!("Exit"), custodian.clone()),
            (token_id.clone(),),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Lock / Unlock
    // -----------------------------------------------------------------------

    pub fn lock(env: Env, admin: Address, token_id: String) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        let mut metadata: TokenMetadata = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

        if metadata.is_locked {
            return Err(ContractError::TokenLocked);
        }

        metadata.is_locked = true;

        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(token_id.clone()), &metadata);

        env.events().publish(
            (symbol_short!("Locked"), admin.clone()),
            (token_id.clone(),),
        );

        Ok(())
    }

    pub fn unlock(env: Env, admin: Address, token_id: String) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        let mut metadata: TokenMetadata = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

        if !metadata.is_locked {
            return Err(ContractError::TokenLocked);
        }

        metadata.is_locked = false;

        env.storage()
            .instance()
            .set(&DataKey::TokenMeta(token_id.clone()), &metadata);

        env.events().publish(
            (symbol_short!("Unlocked"), admin.clone()),
            (token_id.clone(),),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Query functions
    // -----------------------------------------------------------------------

    pub fn get_token_metadata(
        env: Env,
        token_id: String,
    ) -> Result<TokenMetadata, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)
    }

    pub fn get_owner(env: Env, token_id: String) -> Result<Address, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::Owner(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Derives the calendar year from a Unix timestamp (Howard Hinnant's
/// days-from-epoch algorithm), avoiding any need for `alloc`/`chrono` in this
/// `no_std` crate.
fn year_from_timestamp(timestamp: u64) -> u32 {
    let days = (timestamp / 86_400) as i64;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    year as u32
}

fn write_padded_number(buf: &mut [u8], pos: &mut usize, mut value: u64, min_width: usize) {
    let mut digits = [0u8; 20];
    let mut count = 0usize;
    if value == 0 {
        digits[0] = b'0';
        count = 1;
    } else {
        while value > 0 {
            digits[count] = b'0' + (value % 10) as u8;
            value /= 10;
            count += 1;
        }
    }
    for _ in count..min_width {
        buf[*pos] = b'0';
        *pos += 1;
    }
    for i in (0..count).rev() {
        buf[*pos] = digits[i];
        *pos += 1;
    }
}

/// Builds a `SN-YYYY-NNNNNN` token id without `format!`, since this crate has
/// no `alloc` support.
fn generate_token_id(env: &Env, year: u32, counter: u64) -> String {
    let mut buf = [0u8; 32];
    let mut pos = 0usize;
    buf[pos] = b'S';
    pos += 1;
    buf[pos] = b'N';
    pos += 1;
    buf[pos] = b'-';
    pos += 1;
    write_padded_number(&mut buf, &mut pos, year as u64, 4);
    buf[pos] = b'-';
    pos += 1;
    write_padded_number(&mut buf, &mut pos, counter, 6);
    String::from_bytes(env, &buf[..pos])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Map};

    // -----------------------------------------------------------------------
    // ContractError discriminants
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_contract_error_discriminants() {
        assert_eq!(ContractError::AlreadyInitialized as u32, 1);
        assert_eq!(ContractError::Unauthorized as u32, 2);
        assert_eq!(ContractError::TokenNotFound as u32, 3);
        assert_eq!(ContractError::TokenLocked as u32, 4);
        assert_eq!(ContractError::InvalidCommodity as u32, 5);
        assert_eq!(ContractError::InvalidWeight as u32, 6);
    }

    // -----------------------------------------------------------------------
    // DataKey variants
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_datakey_variants_exist() {
        let env = Env::default();

        let _admin = DataKey::Admin.clone();
        let _custodians = DataKey::Custodian(Address::generate(&env));
        let _token_meta = DataKey::TokenMeta(String::from_str(&env, "token_id"));
        let _owner = DataKey::Owner(String::from_str(&env, "token_id"));
        let _token_counter = DataKey::TokenCounter.clone();
    }

    // -----------------------------------------------------------------------
    // TokenMetadata round-trip through contract storage
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_token_metadata_roundtrip() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let key = String::from_str(&env, "token-123");
        let custodian = Address::generate(&env);

        let metadata = TokenMetadata {
            token_id: key.clone(),
            commodity: String::from_str(&env, "SESAME"),
            grade: String::from_str(&env, "Grade A"),
            bag_count: 100,
            weight_per_bag_kg: 50,
            total_weight_kg: 5_000,
            warehouse_id: String::from_str(&env, "warehouse-1"),
            custodian: custodian.clone(),
            deposit_ts: 1_700_000_000,
            is_locked: true,
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
        let env = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client = SesameReceiptContractClient::new(&env, &contract_id);

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
        let env = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client = SesameReceiptContractClient::new(&env, &contract_id);

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

        assert_eq!(token_id, String::from_str(&env, "SN-1970-000001"));
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

        assert_eq!(token_id_1, String::from_str(&env, "SN-1970-000001"));
        assert_eq!(token_id_2, String::from_str(&env, "SN-1970-000002"));
    }

    #[test]
    fn sesame_test_commodity_accepts_only_sesame() {
        let env = Env::default();

        let valid = String::from_str(&env, "SESAME");
        let invalid_maize_white = String::from_str(&env, "MAIZE_WHITE");
        let invalid_maize_yellow = String::from_str(&env, "MAIZE_YELLOW");
        let invalid_wheat = String::from_str(&env, "WHEAT");
        let invalid_empty = String::from_str(&env, "");

        let accepts = |c: &String| -> bool { *c == valid };

        assert!(accepts(&valid), "SESAME must be accepted");
        assert!(!accepts(&invalid_maize_white), "MAIZE_WHITE must be rejected");
        assert!(!accepts(&invalid_maize_yellow), "MAIZE_YELLOW must be rejected");
        assert!(!accepts(&invalid_wheat), "WHEAT must be rejected");
        assert!(!accepts(&invalid_empty), "empty string must be rejected");
    }

    #[test]
    fn sesame_test_version() {
        let env = Env::default();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client = SesameReceiptContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), String::from_str(&env, "0.1.0"));
    }

    // -----------------------------------------------------------------------
    // Helper: setup a test contract with admin + custodian
    // -----------------------------------------------------------------------

    fn setup() -> (Env, Address, SesameReceiptContractClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client = SesameReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        (env, contract_id, client, admin, custodian, farmer)
    }

    fn mint_token(
        env: &Env,
        client: &SesameReceiptContractClient,
        custodian: &Address,
        farmer: &Address,
    ) -> String {
        client.mint(
            custodian,
            farmer,
            &String::from_str(env, "SESAME"),
            &String::from_str(env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(env, "warehouse-1"),
        )
    }

    // -----------------------------------------------------------------------
    // add_custodian / remove_custodian
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_mint_rejects_unauthorized_custodian() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, SesameReceiptContract);
        let client = SesameReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer = Address::generate(&env);
        client.init(&admin);

        let result = client.try_mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "SESAME"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    // -----------------------------------------------------------------------
    // transfer
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_transfer_success() {
        let (env, contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let buyer = Address::generate(&env);
        client.transfer(&token_id, &farmer, &buyer);

        let owner: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Owner(token_id))
                .unwrap()
        });
        assert_eq!(owner, buyer);
    }

    #[test]
    fn sesame_test_transfer_non_owner() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let attacker = Address::generate(&env);
        let buyer = Address::generate(&env);
        let result = client.try_transfer(&token_id, &attacker, &buyer);

        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn sesame_test_transfer_locked_token() {
        let (env, _contract_id, client, admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        client.lock(&admin, &token_id);

        let buyer = Address::generate(&env);
        let result = client.try_transfer(&token_id, &farmer, &buyer);

        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));
    }

    // -----------------------------------------------------------------------
    // burn
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_burn_success() {
        let (env, contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        client.burn(&custodian, &token_id);

        let meta_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::TokenMeta(token_id.clone()))
        });
        let owner_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::Owner(token_id))
        });
        assert!(!meta_exists);
        assert!(!owner_exists);
    }

    #[test]
    fn sesame_test_burn_wrong_custodian() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let other_custodian = Address::generate(&env);
        let result = client.try_burn(&other_custodian, &token_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn sesame_test_burn_nonexistent_token() {
        let (env, _contract_id, client, _admin, custodian, _farmer) = setup();
        let result = client.try_burn(&custodian, &String::from_str(&env, "SN-2024-000001"));
        assert_eq!(result, Err(Ok(ContractError::TokenNotFound)));
    }

    // -----------------------------------------------------------------------
    // lock
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_lock_success() {
        let (env, contract_id, client, admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        client.lock(&admin, &token_id);

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert!(stored.is_locked);
    }

    #[test]
    fn sesame_test_lock_unauthorized() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let non_admin = Address::generate(&env);
        let result = client.try_lock(&non_admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn sesame_test_double_lock_rejected() {
        let (env, _contract_id, client, admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        client.lock(&admin, &token_id);

        let result = client.try_lock(&admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));
    }

    // -----------------------------------------------------------------------
    // unlock
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_unlock_success() {
        let (env, contract_id, client, admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        client.lock(&admin, &token_id);

        let stored_before: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        assert!(stored_before.is_locked);

        client.unlock(&admin, &token_id);

        let stored_after: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert!(!stored_after.is_locked);
    }

    #[test]
    fn sesame_test_unlock_unauthorized() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let non_admin = Address::generate(&env);
        let result = client.try_unlock(&non_admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn sesame_test_unlock_not_locked() {
        let (env, _contract_id, client, admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);
        // Token starts unlocked, so unlock should fail with TokenLocked
        let result = client.try_unlock(&admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));
    }

    // -----------------------------------------------------------------------
    // query functions
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_get_token_metadata() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let meta = client.get_token_metadata(&token_id);
        assert_eq!(meta.token_id, token_id);
        assert_eq!(meta.commodity, String::from_str(&env, "SESAME"));
    }

    #[test]
    fn sesame_test_get_owner() {
        let (env, _contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        let owner = client.get_owner(&token_id);
        assert_eq!(owner, farmer);
    }

    #[test]
    fn sesame_test_get_token_metadata_nonexistent() {
        let (env, _contract_id, client, _admin, _custodian, _farmer) = setup();

        let result = client.try_get_token_metadata(&String::from_str(&env, "SN-2024-999999"));
        assert_eq!(result, Err(Ok(ContractError::TokenNotFound)));
    }

    // -----------------------------------------------------------------------
    // mint token id format
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_token_id_format() {
        let (env, contract_id, client, _admin, custodian, farmer) = setup();
        let token_id = mint_token(&env, &client, &custodian, &farmer);

        assert_eq!(token_id.len(), 14);
        let mut buf = [0u8; 14];
        token_id.copy_into_slice(&mut buf);
        assert_eq!(&buf[0..3], b"SN-");
        assert_eq!(buf[7], b'-');
        for &b in &buf[3..7] {
            assert!(b.is_ascii_digit());
        }
        for &b in &buf[8..14] {
            assert!(b.is_ascii_digit());
        }
    }

    // -----------------------------------------------------------------------
    // counter increments
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_counter_increments() {
        let (env, contract_id, client, _admin, custodian, farmer) = setup();
        mint_token(&env, &client, &custodian, &farmer);
        let counter_1: u64 = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenCounter)
                .unwrap()
        });

        mint_token(&env, &client, &custodian, &farmer);
        let counter_2: u64 = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenCounter)
                .unwrap()
        });

        assert_eq!(counter_2, counter_1 + 1);
    }

    // -----------------------------------------------------------------------
    // total weight calculated correctly
    // -----------------------------------------------------------------------

    #[test]
    fn sesame_test_total_weight_calculated() {
        let (env, contract_id, client, _admin, custodian, farmer) = setup();

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "SESAME"),
            &String::from_str(&env, "Grade A"),
            &7u32,
            &63u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert_eq!(stored.total_weight_kg, 7 * 63);
    }
}
