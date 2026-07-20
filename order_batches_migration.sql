CREATE TABLE IF NOT EXISTS daily_order_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    daily_order_id UUID NOT NULL REFERENCES daily_orders(id) ON DELETE CASCADE,
    qty_change NUMERIC NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS daily_order_batches_order_id_idx
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
