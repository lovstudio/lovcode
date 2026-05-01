//! Cookie extraction for the Claude desktop app's claude.ai session.
//!
//! Reads `~/Library/Application Support/Claude/Cookies` (Chromium-format SQLite,
//! AES-128-CBC encrypted with a Keychain-stored master key). The DB is copied
//! to a tempfile first to avoid lock contention while the app is running.

use std::path::Path;

const COOKIE_NAMES: &[&str] = &["sessionKey", "lastActiveOrg"];

pub fn read_claude_app_cookies() -> Result<std::collections::HashMap<String, String>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let cookies_db = home.join("Library/Application Support/Claude/Cookies");
    if !cookies_db.exists() {
        return Err("Claude desktop app cookies db not found".to_string());
    }

    let tmp = std::env::temp_dir().join(format!("lovcode-cookies-{}.db", std::process::id()));
    std::fs::copy(&cookies_db, &tmp).map_err(|e| format!("copy cookies db: {}", e))?;
    let result = read_cookies_from_db(&tmp);
    let _ = std::fs::remove_file(&tmp);
    result
}

fn read_cookies_from_db(db_path: &Path) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = rusqlite::Connection::open_with_flags(
        db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).map_err(|e| format!("open cookies db: {}", e))?;

    let names_in: String = COOKIE_NAMES.iter().map(|n| format!("'{}'", n)).collect::<Vec<_>>().join(",");
    let q = format!(
        "SELECT name, value, encrypted_value FROM cookies \
         WHERE host_key LIKE '%claude.ai%' AND name IN ({})",
        names_in
    );

    let mut stmt = conn.prepare(&q).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let name: String = row.get(0)?;
        let value: String = row.get(1)?;
        let enc: Vec<u8> = row.get(2)?;
        Ok((name, value, enc))
    }).map_err(|e| e.to_string())?;

    let key = derive_keychain_key()?;
    let mut out = std::collections::HashMap::new();
    for r in rows {
        let (name, plain, enc) = r.map_err(|e| e.to_string())?;
        let v = if !plain.is_empty() {
            plain
        } else if enc.is_empty() {
            continue
        } else {
            decrypt_cookie(&enc, &key)?
        };
        out.insert(name, v);
    }
    Ok(out)
}

#[cfg(target_os = "macos")]
fn derive_keychain_key() -> Result<[u8; 16], String> {
    use security_framework::passwords::get_generic_password;
    // Chromium-derived apps store an AES master password under a service named
    // `<AppName> Safe Storage`. We don't know the exact string, so try common
    // variants. The account field is typically the same as the app name.
    let candidates: &[(&str, &str)] = &[
        ("Claude Safe Storage", "Claude Key"),
    ];
    let mut tried = Vec::new();
    for (service, account) in candidates {
        match get_generic_password(service, account) {
            Ok(pw) => return derive_aes_key(&pw),
            Err(e) => {
                let s = e.to_string();
                tried.push(format!("'{}'/'{}'->{}", service, account, s));
                // ACL denial vs entry-missing have very different fixes.
                if s.contains("not correct") || s.contains("not authorized") || s.contains("user name") {
                    return Err(format!(
                        "macOS keychain blocked lovcode from reading 'Claude Safe Storage'. \
                        Open Keychain Access, search 'Claude Safe Storage', double-click → \
                        Access Control tab → add this binary or check 'Allow all applications'. \
                        Original error: {}",
                        s
                    ));
                }
            }
        }
    }
    Err(format!(
        "Claude Safe Storage keychain entry not found. Tried: {}",
        tried.join("; ")
    ))
}

#[cfg(not(target_os = "macos"))]
fn derive_keychain_key() -> Result<[u8; 16], String> {
    Err("cookie decryption only implemented on macOS".to_string())
}

fn derive_aes_key(passphrase: &[u8]) -> Result<[u8; 16], String> {
    use pbkdf2::pbkdf2_hmac;
    use sha1::Sha1;
    let salt = b"saltysalt";
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(passphrase, salt, 1003, &mut key);
    Ok(key)
}

fn decrypt_cookie(enc: &[u8], key: &[u8; 16]) -> Result<String, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    if enc.len() < 3 || (&enc[0..3] != b"v10" && &enc[0..3] != b"v11") {
        let prefix_hex: String = enc.iter().take(8).map(|b| format!("{:02x}", b)).collect();
        return Err(format!(
            "unknown cookie encryption prefix: first 8 bytes = {}",
            prefix_hex
        ));
    }
    let body = &enc[3..];
    let iv = [b' '; 16];
    let cipher = Aes128CbcDec::new(key.into(), &iv.into());
    let mut buf = body.to_vec();
    let plain = cipher.decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| format!("decrypt cookie: {}", e))?;

    // Chromium >=v10 prepends a 32-byte SHA256 of the host. Strip if it parses
    // cleaner without it; otherwise return the raw decoded bytes.
    if plain.len() > 32 {
        if let Ok(s) = std::str::from_utf8(&plain[32..]) {
            if !s.is_empty() {
                return Ok(s.to_string());
            }
        }
    }
    String::from_utf8(plain.to_vec()).map_err(|e| format!("utf8: {}", e))
}
