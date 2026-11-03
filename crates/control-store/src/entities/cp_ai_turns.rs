//! This projection has a nullable unique key, not a primary key.
//! Use typed SeaQuery identifiers without inventing an ORM primary key.
use sea_orm::DeriveIden;

#[derive(Clone, Copy, Debug, DeriveIden)]
#[sea_orm(iden = "cp_ai_turns")]
pub struct Entity;

#[derive(Clone, Copy, Debug, DeriveIden)]
pub enum Column {
    RegistrationId,
    SessionId,
    TurnId,
    EndedAt,
    MemberId,
    Model,
    Usage,
}
