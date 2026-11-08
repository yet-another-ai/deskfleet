export type AccountDeletionStatus = "pending" | "approved" | "rejected" | "cancelled"

export interface AccountDeletionRequest {
  id: string
  reason: string
  status: AccountDeletionStatus
  requestedAt: string
  reviewedAt: string | null
  reviewNote: string | null
}

export interface AdminAccountDeletionRequest {
  id: string
  reason: string
  status: "pending"
  requestedAt: string
  user: { id: string; name: string; email: string }
}

export interface AccountDeletionRequestPage {
  requests: AdminAccountDeletionRequest[]
  nextCursor: string | null
}

export interface AccountDeletionRequestQuery {
  /** The last request ID of the previous page. */
  cursor?: string
  limit?: number
}
