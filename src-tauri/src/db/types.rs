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
    pub avatar_data_url: Option<String>,
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
