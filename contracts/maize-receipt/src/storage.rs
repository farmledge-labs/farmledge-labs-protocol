use soroban_sdk::{contracttype, Address, String};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Custodians,
    TokenMeta(String),
    Owner(String),
    WalletTokens(Address),
    TokenCounter,
    AllTokens,
}
