CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NULL,
    password TEXT NULL,
    email TEXT UNIQUE NULL,
    provider TEXT NOT NULL DEFAULT 'local' CHECK (provider IN ('local', 'google')),
    role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT NULL;
