#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, String};

#[contract]
pub struct MaizeReceiptContract;

#[contractimpl]
impl MaizeReceiptContract {
    pub fn init(_env: Env, _admin: Address) {}

    pub fn version(env: Env) -> String {
        String::from_str(&env, "0.1.0")
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_version() {
        let env = Env::default();
        let contract_id = env.register_contract(None, MaizeReceiptContract);
        let client = MaizeReceiptContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), String::from_str(&env, "0.1.0"));
    }
}
