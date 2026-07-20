CREATE TABLE IF NOT EXISTS daily_order_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    daily_order_id UUID NOT NULL REFERENCES daily_orders(id) ON DELETE CASCADE,
    qty_change NUMERIC NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'daily_order_batches'
          AND column_name = 'order_id'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'daily_order_batches'
          AND column_name = 'daily_order_id'
    ) THEN
        ALTER TABLE daily_order_batches RENAME COLUMN order_id TO daily_order_id;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS daily_order_batches_daily_order_id_idx
    ON daily_order_batches (daily_order_id, created_at);

INSERT INTO daily_order_batches (daily_order_id, qty_change, note)
SELECT orders.id, orders.qty, 'Đợt sáng mặc định'
FROM daily_orders AS orders
WHERE orders.qty <> 0
  AND NOT EXISTS (
      SELECT 1
      FROM daily_order_batches AS batches
      WHERE batches.daily_order_id = orders.id
  );
