use crate::{ControlStore, Result, sql};
use sea_orm::ConnectionTrait;

impl ControlStore {
    /// Coalesce global maintenance across API replicas. The server bounds a pass
    /// to less than this lease and retries unfinished batches on the next pass.
    pub async fn claim_expiry_maintenance(&self) -> Result<bool> {
        Ok(self.db.execute_raw(sql(
            "UPDATE cp_maintenance SET next_run_at=statement_timestamp()+interval '30 seconds' WHERE name='expiry' AND next_run_at<=statement_timestamp()",
            vec![],
        )).await?.rows_affected() == 1)
    }
}
