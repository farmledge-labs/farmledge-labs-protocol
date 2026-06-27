#![no_std]

mod errors;
mod storage;

pub use errors::ContractError;
use storage::DataKey;

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Map, String, Vec};

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

/// Builds a `KN-YYYY-NNNNNN` token id without `format!`, since this crate has
/// no `alloc` support.
fn generate_token_id(env: &Env, year: u32, counter: u64) -> String {
    let mut buf = [0u8; 32];
    let mut pos = 0usize;
    buf[pos] = b'K';
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

#[contract]
pub struct MaizeReceiptContract;

#[contractimpl]
impl MaizeReceiptContract {
    pub fn init(env: Env, admin: Address) -> Result<(), ContractError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ContractError::AlreadyInitialized);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenCounter, &0u64);
        Ok(())
    }

    pub fn add_custodian(env: Env, admin: Address, custodian: Address) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        let mut custodians: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::Custodians)
            .unwrap_or_else(|| Map::new(&env));

        custodians.set(custodian, true);
        env.storage().instance().set(&DataKey::Custodians, &custodians);

        Ok(())
    }

    pub fn remove_custodian(env: Env, admin: Address, custodian: Address) -> Result<(), ContractError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ContractError::Unauthorized)?;

        if admin != stored_admin {
            return Err(ContractError::Unauthorized);
        }

        let mut custodians: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::Custodians)
            .unwrap_or_else(|| Map::new(&env));

        custodians.remove(custodian);
        env.storage().instance().set(&DataKey::Custodians, &custodians);

        Ok(())
    }

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

        let custodians: Map<Address, bool> = env
            .storage()
            .instance()
            .get(&DataKey::Custodians)
            .unwrap_or_else(|| Map::new(&env));

        if !custodians.get(custodian.clone()).unwrap_or(false) {
            return Err(ContractError::Unauthorized);
        }

        let maize_white = String::from_str(&env, "MAIZE_WHITE");
        let maize_yellow = String::from_str(&env, "MAIZE_YELLOW");
        if commodity != maize_white && commodity != maize_yellow {
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
        env.storage().instance().set(&DataKey::TokenCounter, &counter);

        let year = year_from_timestamp(env.ledger().timestamp());
        let token_id = generate_token_id(&env, year, counter);

        let total_weight_kg = bag_count * weight_per_bag_kg;

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

        // Track all tokens for query_balance iteration
        let mut all_tokens: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::AllTokens)
            .unwrap_or_else(|| Vec::new(&env));
        all_tokens.push_back(token_id.clone());
        env.storage()
            .instance()
            .set(&DataKey::AllTokens, &all_tokens);

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

    pub fn query_balance(env: Env, wallet: Address) -> Vec<String> {
        let all_tokens: Vec<String> = env
            .storage()
            .instance()
            .get(&DataKey::AllTokens)
            .unwrap_or_else(|| Vec::new(&env));
        let mut result = Vec::new(&env);
        for token_id in all_tokens.iter() {
            let owner: Option<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Owner(token_id.clone()));
            if let Some(owner) = owner {
                if owner == wallet {
                    result.push_back(token_id.clone());
                }
            }
        }
        result
    }

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

    pub fn burn(env: Env, custodian: Address, token_id: String) -> Result<(), ContractError> {
        let metadata: TokenMetadata = env
            .storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)?;

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
    // Query functions
    // -----------------------------------------------------------------------

    pub fn query_token(
        env: Env,
        token_id: String,
    ) -> Result<TokenMetadata, ContractError> {
        env.storage()
            .instance()
            .get(&DataKey::TokenMeta(token_id.clone()))
            .ok_or(ContractError::TokenNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env, Map};

    #[test]
    fn test_init_sets_admin() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let stored: Address = env
            .as_contract(&contract_id, || {
                env.storage().instance().get(&DataKey::Admin).unwrap()
            });
        assert_eq!(stored, admin);
    }

    #[test]
    fn test_init_sets_counter_to_zero() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let counter: u64 = env
            .as_contract(&contract_id, || {
                env.storage().instance().get(&DataKey::TokenCounter).unwrap()
            });
        assert_eq!(counter, 0u64);
    }

    #[test]
    fn test_add_custodian_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian), Some(true));
    }

    #[test]
    fn test_add_custodian_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        client.init(&admin);

        let result = client.try_add_custodian(&non_admin, &custodian);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_add_multiple_custodians() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian_a = Address::generate(&env);
        let custodian_b = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian_a);
        client.add_custodian(&admin, &custodian_b);

        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian_a), Some(true));
        assert_eq!(custodians.get(custodian_b), Some(true));
    }

    #[test]
    fn test_remove_custodian_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);
        client.remove_custodian(&admin, &custodian);

        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian), None);
    }

    #[test]
    fn test_remove_custodian_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let result = client.try_remove_custodian(&non_admin, &custodian);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_remove_custodian_does_not_affect_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        let token_id = String::from_str(&env, "token-123");
        let metadata = TokenMetadata {
            token_id: token_id.clone(),
            commodity: String::from_str(&env, "MAIZE_WHITE"),
            grade: String::from_str(&env, "Grade A"),
            bag_count: 100,
            weight_per_bag_kg: 50,
            total_weight_kg: 5000,
            warehouse_id: String::from_str(&env, "warehouse-1"),
            custodian: custodian.clone(),
            deposit_ts: 1_700_000_000,
            is_locked: true,
        };

        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::TokenMeta(token_id.clone()), &metadata);
        });

        client.remove_custodian(&admin, &custodian);

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert_eq!(stored, metadata);

        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian), None);
    }

    fn setup_with_custodian(env: &Env) -> (Address, Address, Address, Address) {
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(env, &contract_id);

        let admin = Address::generate(env);
        let custodian = Address::generate(env);
        let farmer = Address::generate(env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);

        (contract_id, admin, custodian, farmer)
    }

    #[test]
    fn test_mint_rejects_unauthorized_custodian() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer = Address::generate(&env);
        client.init(&admin);

        let result = client.try_mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_mint_rejects_invalid_commodity() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &_contract_id);

        let result = client.try_mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "WHEAT"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidCommodity)));
    }

    #[test]
    fn test_mint_rejects_zero_bag_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let result = client.try_mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &0u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidWeight)));
    }

    #[test]
    fn test_mint_rejects_zero_weight() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let result = client.try_mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &0u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert_eq!(result, Err(Ok(ContractError::InvalidWeight)));
    }

    #[test]
    fn test_mint_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        assert_eq!(stored.token_id, token_id);
        assert_eq!(stored.custodian, custodian);
        assert!(!stored.is_locked);

        let owner: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Owner(token_id))
                .unwrap()
        });
        assert_eq!(owner, farmer);
    }

    #[test]
    fn test_transfer_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

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
    fn test_transfer_non_owner() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let attacker = Address::generate(&env);
        let buyer = Address::generate(&env);
        let result = client.try_transfer(&token_id, &attacker, &buyer);

        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));

        let owner: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Owner(token_id))
                .unwrap()
        });
        assert_eq!(owner, farmer);
    }

    #[test]
    fn test_transfer_locked_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let metadata: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        let locked_metadata = TokenMetadata {
            token_id: metadata.token_id,
            commodity: metadata.commodity,
            grade: metadata.grade,
            bag_count: metadata.bag_count,
            weight_per_bag_kg: metadata.weight_per_bag_kg,
            total_weight_kg: metadata.total_weight_kg,
            warehouse_id: metadata.warehouse_id,
            custodian: metadata.custodian,
            deposit_ts: metadata.deposit_ts,
            is_locked: true,
        };

        env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .set(&DataKey::TokenMeta(token_id.clone()), &locked_metadata);
        });

        let buyer = Address::generate(&env);
        let result = client.try_transfer(&token_id, &farmer, &buyer);

        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));

        let owner: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Owner(token_id))
                .unwrap()
        });
        assert_eq!(owner, farmer);
    }

    #[test]
    fn test_burn_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        client.burn(&custodian, &token_id);

        let meta_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::TokenMeta(token_id.clone()))
        });
        let owner_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::Owner(token_id.clone()))
        });
        assert!(!meta_exists);
        assert!(!owner_exists);
    }

    #[test]
    fn test_burn_wrong_custodian() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let other_custodian = Address::generate(&env);
        let result = client.try_burn(&other_custodian, &token_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));

        let meta_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::TokenMeta(token_id))
        });
        assert!(meta_exists);
    }

    #[test]
    fn test_burn_nonexistent_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, _farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let result = client.try_burn(&custodian, &String::from_str(&env, "KN-2024-000001"));
        assert_eq!(result, Err(Ok(ContractError::TokenNotFound)));
    }

    #[test]
    fn test_lock_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

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
    fn test_lock_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let non_admin = Address::generate(&env);
        let result = client.try_lock(&non_admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
    }

    #[test]
    fn test_double_lock_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        client.lock(&admin, &token_id);

        let result = client.try_lock(&admin, &token_id);
        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));
    }

    #[test]
    fn test_mint_token_id_format() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        assert_eq!(token_id.len(), 14);
        let mut buf = [0u8; 14];
        token_id.copy_into_slice(&mut buf);
        assert_eq!(&buf[0..3], b"KN-");
        assert_eq!(buf[7], b'-');
        for &b in &buf[3..7] {
            assert!(b.is_ascii_digit());
        }
        for &b in &buf[8..14] {
            assert!(b.is_ascii_digit());
        }
    }

    #[test]
    fn test_mint_counter_increments() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        let counter_1: u64 = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::TokenCounter).unwrap()
        });

        client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        let counter_2: u64 = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::TokenCounter).unwrap()
        });

        assert_eq!(counter_2, counter_1 + 1);
    }

    #[test]
    fn test_mint_total_weight_calculated_correctly() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
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

    #[test]
    fn test_init_rejects_double_call() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let result = client.try_init(&admin);
        assert_eq!(
            result,
            Err(Ok(ContractError::AlreadyInitialized))
        );
    }

    #[test]
    fn test_datakey_variants_exist() {
        let env = Env::default();
        let _admin = DataKey::Admin.clone();
        let _custodians = DataKey::Custodians.clone();
        let _token_meta = DataKey::TokenMeta(String::from_str(&env, "token_id"));
        let _owner = DataKey::Owner(String::from_str(&env, "token_id"));
        let _token_counter = DataKey::TokenCounter.clone();

        let _ = _admin;
        let _ = _custodians;
        let _ = _token_meta;
        let _ = _owner;
        let _ = _token_counter;
    }

    #[test]
    fn test_token_metadata_fields() {
        let env = Env::default();
        let custodian = Address::generate(&env);
        let metadata = TokenMetadata {
            token_id: String::from_str(&env, "token-123"),
            commodity: String::from_str(&env, "MAIZE_WHITE"),
            grade: String::from_str(&env, "Grade A"),
            bag_count: 100,
            weight_per_bag_kg: 50,
            total_weight_kg: 5000,
            warehouse_id: String::from_str(&env, "warehouse-1"),
            custodian: custodian.clone(),
            deposit_ts: 1_700_000_000,
            is_locked: true,
        };

        assert_eq!(metadata.token_id, String::from_str(&env, "token-123"));
        assert_eq!(metadata.commodity, String::from_str(&env, "MAIZE_WHITE"));
        assert_eq!(metadata.grade, String::from_str(&env, "Grade A"));
        assert_eq!(metadata.bag_count, 100);
        assert_eq!(metadata.weight_per_bag_kg, 50);
        assert_eq!(metadata.total_weight_kg, 5000);
        assert_eq!(metadata.warehouse_id, String::from_str(&env, "warehouse-1"));
        assert_eq!(metadata.custodian, custodian);
        assert_eq!(metadata.deposit_ts, 1_700_000_000);
        assert!(metadata.is_locked);
    }

    #[test]
    fn test_token_metadata_roundtrip() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let key = String::from_str(&env, "token-123");
        let custodian = Address::generate(&env);
        let metadata = TokenMetadata {
            token_id: key.clone(),
            commodity: String::from_str(&env, "MAIZE_WHITE"),
            grade: String::from_str(&env, "Grade A"),
            bag_count: 100,
            weight_per_bag_kg: 50,
            total_weight_kg: 5000,
            warehouse_id: String::from_str(&env, "warehouse-1"),
            custodian: custodian.clone(),
            deposit_ts: 1_700_000_000,
            is_locked: true,
        };

        env.as_contract(&contract_id, || {
            env.storage().instance().set(&DataKey::TokenMeta(key.clone()), &metadata);
        });

        let stored: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::TokenMeta(key)).unwrap()
        });

        assert_eq!(stored, metadata);
    }

    #[test]
    fn test_query_token_success() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let custodian = Address::generate(&env);
        let farmer = Address::generate(&env);
        client.init(&admin);
        client.add_custodian(&admin, &custodian);
        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let meta = client.query_token(&token_id);
        assert_eq!(meta.token_id, token_id);
        assert_eq!(meta.commodity, String::from_str(&env, "MAIZE_WHITE"));
        assert_eq!(meta.bag_count, 10u32);
        assert_eq!(meta.weight_per_bag_kg, 50u32);
        assert_eq!(meta.total_weight_kg, 500u32);
        assert_eq!(meta.custodian, custodian);
        assert!(!meta.is_locked);
    }

    #[test]
    fn test_query_token_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.init(&admin);

        let result = client.try_query_token(&String::from_str(&env, "KN-2024-999999"));
        assert_eq!(result, Err(Ok(ContractError::TokenNotFound)));
    }

    #[test]
    fn test_unlock_success() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        // Lock the token first
        client.lock(&admin, &token_id);

        // Verify it's locked
        let locked_metadata: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        assert!(locked_metadata.is_locked);

        // Now unlock it
        client.unlock(&admin, &token_id);

        // Verify it's unlocked
        let unlocked_metadata: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert!(!unlocked_metadata.is_locked);
    }

    #[test]
    fn test_unlock_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        // Lock the token
        client.lock(&admin, &token_id);

        // Non-admin tries to unlock
        let non_admin = Address::generate(&env);
        let result = client.try_unlock(&non_admin, &token_id);

        assert_eq!(result, Err(Ok(ContractError::Unauthorized)));

        // Verify it's still locked
        let metadata: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert!(metadata.is_locked);
    }

    #[test]
    fn test_lock_unlock_transfer_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        // Lock the token
        client.lock(&admin, &token_id);

        // Verify transfer is blocked when locked
        let buyer = Address::generate(&env);
        let result = client.try_transfer(&token_id, &farmer, &buyer);
        assert_eq!(result, Err(Ok(ContractError::TokenLocked)));

        // Unlock the token
        client.unlock(&admin, &token_id);

        // Verify transfer succeeds after unlock
        client.transfer(&token_id, &farmer, &buyer);

        // Verify ownership changed
        let owner: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::Owner(token_id))
                .unwrap()
        });
        assert_eq!(owner, buyer);
    }

    #[test]
    fn test_query_balance_returns_owned_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let token_a = client.mint(
            &custodian, &farmer,
            &String::from_str(&env, "MAIZE_WHITE"), &String::from_str(&env, "Grade A"),
            &10u32, &50u32, &String::from_str(&env, "warehouse-1"),
        );
        let token_b = client.mint(
            &custodian, &farmer,
            &String::from_str(&env, "MAIZE_YELLOW"), &String::from_str(&env, "Grade B"),
            &5u32, &50u32, &String::from_str(&env, "warehouse-2"),
        );

        let balance = client.query_balance(&farmer);
        assert_eq!(balance.len(), 2);
        assert!(balance.contains(token_a.clone()));
        assert!(balance.contains(token_b.clone()));
    }

    #[test]
    fn test_query_balance_excludes_other_wallets() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, custodian, farmer_a) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let farmer_b = Address::generate(&env);
        client.mint(
            &custodian, &farmer_a,
            &String::from_str(&env, "MAIZE_WHITE"), &String::from_str(&env, "Grade A"),
            &10u32, &50u32, &String::from_str(&env, "warehouse-1"),
        );
        client.mint(
            &custodian, &farmer_b,
            &String::from_str(&env, "MAIZE_YELLOW"), &String::from_str(&env, "Grade B"),
            &5u32, &50u32, &String::from_str(&env, "warehouse-2"),
        );

        let balance_a = client.query_balance(&farmer_a);
        assert_eq!(balance_a.len(), 1);
        let balance_b = client.query_balance(&farmer_b);
        assert_eq!(balance_b.len(), 1);
    }

    #[test]
    fn test_query_balance_empty_wallet() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _custodian, _farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        let unknown = Address::generate(&env);
        let balance = client.query_balance(&unknown);
        assert_eq!(balance.len(), 0);}
    // -----------------------------------------------------------------------
    // Lifecycle integration tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_mint_to_transfer_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        // Step 1: Init already done by setup_with_custodian — verify admin
        let stored_admin: Address = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Admin).unwrap()
        });
        assert_eq!(stored_admin, admin);

        // Step 2: Custodian already added — verify custodians
        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian.clone()), Some(true));

        // Step 3: Mint token
        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );

        let meta: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        assert_eq!(meta.bag_count, 10u32);
        assert_eq!(meta.is_locked, false);

        // Step 4: Transfer token to new owner
        let new_owner = Address::generate(&env);
        client.transfer(&token_id, &farmer, &new_owner);

        let stored_owner: Address = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Owner(token_id.clone())).unwrap()
        });
        assert_eq!(stored_owner, new_owner);

        // Step 5: Token metadata still intact after transfer
        let meta_after: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id))
                .unwrap()
        });
        assert_eq!(meta_after.commodity, String::from_str(&env, "MAIZE_WHITE"));
        assert_eq!(meta_after.bag_count, 10u32);
    }

    #[test]
    fn test_lock_unlock_burn_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin, custodian, farmer) = setup_with_custodian(&env);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);

        // Step 1: Init already done — verify admin
        let stored_admin: Address = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Admin).unwrap()
        });
        assert_eq!(stored_admin, admin);

        // Step 2: Custodian already added — verify custodians
        let custodians: Map<Address, bool> = env.as_contract(&contract_id, || {
            env.storage().instance().get(&DataKey::Custodians).unwrap()
        });
        assert_eq!(custodians.get(custodian.clone()), Some(true));

        // Step 3: Mint token
        let token_id = client.mint(
            &custodian,
            &farmer,
            &String::from_str(&env, "MAIZE_WHITE"),
            &String::from_str(&env, "Grade A"),
            &10u32,
            &50u32,
            &String::from_str(&env, "warehouse-1"),
        );
        assert!(!token_id.is_empty());

        // Step 4: Lock token
        client.lock(&admin, &token_id);

        // Verify locked
        let meta_locked: TokenMetadata = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&DataKey::TokenMeta(token_id.clone()))
                .unwrap()
        });
        assert!(meta_locked.is_locked);

        // Step 5: Transfer rejected on locked token
        let receiver = Address::generate(&env);
        let transfer_result = client.try_transfer(&token_id, &farmer, &receiver);
        assert_eq!(transfer_result, Err(Ok(ContractError::TokenLocked)));

        // Step 6: Burn the token
        client.burn(&custodian, &token_id);

        let meta_exists = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&DataKey::TokenMeta(token_id))
        });
        assert!(!meta_exists);
    }
}
