#![no_std]

mod errors;
mod storage;

pub use errors::ContractError;
use storage::DataKey;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, String};

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
}
