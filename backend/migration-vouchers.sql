-- =====================================
-- Voucher / 兑换码机制
-- =====================================

CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_text TEXT UNIQUE NOT NULL,
    times_remaining INTEGER NOT NULL DEFAULT 0,
    expire_date DATE NOT NULL,
    credit_amount INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    voucher_id INTEGER NOT NULL,
    redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, voucher_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_voucher_text ON vouchers(voucher_text);
CREATE INDEX IF NOT EXISTS idx_redemptions_user ON voucher_redemptions(user_id);
