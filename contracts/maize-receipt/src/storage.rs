use soroban_sdk::{contracttype, String};

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Admin,
    Custodians,
    TokenMeta(String),
    Owner(String),
    TokenCounter,
    Custodians,
}
