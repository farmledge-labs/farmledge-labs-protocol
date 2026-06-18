use soroban_sdk::{contracttype, String};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Custodians,
    TokenMeta(String),
    Owner(String),
    TokenCounter,
}
