diesel::table! {
    users (user_id) {
        user_id -> Text,
        display_name -> Text,
        public_sign_key -> Text,
        public_dh_key -> Text,
        avatar_hash -> Nullable<Text>,
        bio -> Text,
        discoverability -> Text,
        last_seen_at -> Nullable<Text>,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    servers (server_id) {
        server_id -> Text,
        name -> Text,
        description -> Text,
        icon_hash -> Nullable<Text>,
        owner_id -> Text,
        visibility -> Text,
        member_count -> Integer,
        created_at -> Text,
        updated_at -> Text,
    }
}

diesel::table! {
    server_members (server_id, user_id) {
        server_id -> Text,
        user_id -> Text,
        role -> Text,
        joined_at -> Text,
    }
}

diesel::table! {
    invites (code) {
        code -> Text,
        server_id -> Text,
        server_name -> Text,
        creator_id -> Text,
        endpoints -> Text,
        max_uses -> Nullable<Integer>,
        use_count -> Integer,
        expires_at -> Nullable<Text>,
        created_at -> Text,
    }
}

diesel::table! {
    rate_limit_bans (ip_addr) {
        ip_addr -> Text,
        reason -> Nullable<Text>,
        banned_at -> Text,
        expires_at -> Nullable<Text>,
    }
}

diesel::allow_tables_to_appear_in_same_query!(users, servers, server_members, invites, rate_limit_bans);
diesel::joinable!(servers -> users (owner_id));
diesel::joinable!(invites -> servers (server_id));
