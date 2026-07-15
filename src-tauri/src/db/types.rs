use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MessageRow {
    pub id: String,
    pub channel_id: String,
    pub server_id: String,
    pub author_id: String,
    pub content: Option<String>,
    pub content_type: String,
    pub reply_to_id: Option<String>,
    pub created_at: String,
    pub logical_ts: String,
    pub verified: bool,
    pub raw_attachments: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MutationRow {
    pub id: String,
    #[serde(rename = "type")]
    pub mutation_type: String,
    pub target_id: String,
    pub channel_id: String,
    pub author_id: String,
    pub new_content: Option<String>,
    pub emoji_id: Option<String>,
    pub logical_ts: String,
    pub created_at: String,
    pub verified: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub icon_url: Option<String>,
    pub owner_id: String,
    pub invite_code: Option<String>,
    pub created_at: String,
    pub raw_json: String,
    pub avatar_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelRow {
    pub id: String,
    pub server_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub channel_type: String,
    pub position: i64,
    pub topic: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MemberRow {
    pub user_id: String,
    pub server_id: String,
    pub display_name: String,
    pub roles: Option<String>,
    pub joined_at: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub online_status: String,
    pub bio: Option<String>,
    pub banner_color: Option<String>,
    pub avatar_hash: Option<String>,
    pub banner_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmojiRow {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub file_path: String,
    pub uploaded_by: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeviceRow {
    pub device_id: String,
    pub user_id: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub attested_by: Option<String>,
    pub attestation_sig: Option<String>,
    pub revoked: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InviteCodeRow {
    pub code: String,
    pub server_id: String,
    pub created_by: String,
    pub max_uses: Option<i64>,
    pub use_count: i64,
    pub expires_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModLogRow {
    pub id: String,
    pub server_id: String,
    pub action: String,
    pub target_id: String,
    pub issued_by: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(serde::Serialize)]
pub struct ImageInfo {
    pub path:      String,
    pub mime_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BanRow {
    pub server_id: String,
    pub user_id: String,
    pub banned_by: String,
    pub reason: Option<String>,
    pub banned_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChannelAclRow {
    pub channel_id: String,
    pub allowed_roles: String,   // JSON array
    pub allowed_users: String,   // JSON array
    pub denied_users: String,    // JSON array
    pub private_channel: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JoinRequestRow {
    pub id:              String,
    pub server_id:       String,
    pub user_id:         String,
    pub display_name:    String,
    pub public_sign_key: String,
    pub public_dh_key:   String,
    pub requested_at:    String,
    pub status:          String,  // 'pending' | 'approved' | 'denied'
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GovernanceMotionRow {
    pub id: String,
    pub server_id: String,
    #[serde(rename = "type")]
    pub motion_type: String,
    pub state: String,
    pub is_binding: bool,
    pub seat_count: i64,
    pub proposer_user_id: String,
    pub eligibility_snapshot_json: Option<String>,
    pub discussion_open_at: Option<String>,
    pub vote_open_at: Option<String>,
    pub vote_close_at: Option<String>,
    pub ruleset_json: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GovernanceCandidateRow {
    pub motion_id: String,
    pub candidate_user_id: String,
    pub source: String,
    pub nominated_by_user_id: Option<String>,
    pub seconded_by_user_id: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GovernanceBallotRow {
    pub motion_id: String,
    pub voter_user_id: String,
    pub approved_candidate_ids_json: String,
    pub reject_vote: bool,
    pub abstain_vote: bool,
    pub revision: i64,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GovernancePostRow {
    pub id: String,
    pub motion_id: String,
    pub parent_post_id: Option<String>,
    pub author_user_id: String,
    pub content: String,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub deleted_at: Option<String>,
}
