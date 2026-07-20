CREATE TABLE IF NOT EXISTS vendors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

INSERT INTO vendors (code, name)
VALUES ('system', 'System Tenant')
ON CONFLICT (code) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_id UUID NULL REFERENCES vendors(id) ON DELETE RESTRICT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS temp_pin TEXT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'owner', 'manager', 'staff', 'report-viewer'));

DO $$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'schools',
        'products',
        'categories',
        'stock',
        'daily_orders',
        'daily_order_batches'
    ] LOOP
        EXECUTE format(
            'ALTER TABLE %I ADD COLUMN IF NOT EXISTS vendor_id UUID NULL REFERENCES vendors(id) ON DELETE RESTRICT',
            table_name
        );
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON %I (vendor_id)',
            table_name || '_vendor_id_idx',
            table_name
        );
    END LOOP;
END $$;

DO $$
DECLARE
    system_vendor UUID;
    table_name TEXT;
BEGIN
    SELECT id INTO system_vendor FROM vendors WHERE code = 'system';
    UPDATE users SET vendor_id = system_vendor WHERE vendor_id IS NULL;
    FOREACH table_name IN ARRAY ARRAY[
        'schools',
        'products',
        'categories',
        'stock',
        'daily_orders',
        'daily_order_batches'
    ] LOOP
        EXECUTE format('UPDATE %I SET vendor_id = $1 WHERE vendor_id IS NULL', table_name)
        USING system_vendor;
    END LOOP;
END $$;

ALTER TABLE schools DROP CONSTRAINT IF EXISTS schools_code_key;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_code_key;
ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
ALTER TABLE stock DROP CONSTRAINT IF EXISTS stock_product_id_key;
ALTER TABLE daily_orders DROP CONSTRAINT IF EXISTS unique_date_product_school;

ALTER TABLE schools ADD CONSTRAINT unique_vendor_school_code UNIQUE (vendor_id, code);
ALTER TABLE products ADD CONSTRAINT unique_vendor_product_code UNIQUE (vendor_id, code);
ALTER TABLE categories ADD CONSTRAINT unique_vendor_category_name UNIQUE (vendor_id, name);
ALTER TABLE stock ADD CONSTRAINT unique_vendor_stock_product UNIQUE (vendor_id, product_id);
ALTER TABLE daily_orders ADD CONSTRAINT unique_vendor_date_product_school
    UNIQUE (vendor_id, delivery_date, product_id, school_id);

CREATE UNIQUE INDEX IF NOT EXISTS vendors_code_idx ON vendors (code);
