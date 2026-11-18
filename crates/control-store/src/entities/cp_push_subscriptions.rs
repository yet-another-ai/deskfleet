//! Typed mapping of the cp_push_subscriptions table.
use sea_orm::entity::prelude::*;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "cp_push_subscriptions")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false, column_type = "Text")]
    pub login_session_id: String,
    #[sea_orm(column_type = "Text", indexed)]
    pub user_id: String,
    #[sea_orm(column_type = "Text", unique_key = "channel_token")]
    pub channel: String,
    #[sea_orm(column_type = "Text", unique_key = "channel_token")]
    pub token: String,
    #[sea_orm(column_type = "Text", default_value = "en-US")]
    pub locale: String,
    #[sea_orm(default_value = true)]
    pub enabled: bool,
    #[sea_orm(default_value = true)]
    pub task_completed: bool,
    #[sea_orm(default_value = true)]
    pub task_needs_input: bool,
    pub updated_at: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::cp_login_sessions::Entity",
        from = "Column::LoginSessionId",
        to = "super::cp_login_sessions::Column::Id",
        on_delete = "Cascade"
    )]
    LoginSessions,
    #[sea_orm(
        belongs_to = "super::cp_users::Entity",
        from = "Column::UserId",
        to = "super::cp_users::Column::Id",
        on_delete = "Cascade"
    )]
    Users,
}

impl ActiveModelBehavior for ActiveModel {}
