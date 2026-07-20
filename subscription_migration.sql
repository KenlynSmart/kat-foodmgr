BEGIN;

ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS subscription_due_date DATE;

ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS subscription_status TEXT;

ALTER TABLE public.vendors
    ALTER COLUMN subscription_due_date SET DEFAULT (CURRENT_DATE + 30),
    ALTER COLUMN subscription_status SET DEFAULT 'active';

UPDATE public.vendors
SET subscription_due_date = COALESCE(subscription_due_date, CURRENT_DATE + 30),
    subscription_status = COALESCE(subscription_status, 'active');

DO $migration$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'vendors_subscription_status_check'
          AND conrelid = 'public.vendors'::regclass
    ) THEN
        ALTER TABLE public.vendors
            ADD CONSTRAINT vendors_subscription_status_check
            CHECK (subscription_status IN ('active', 'expired', 'trial'));
    END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS public.subscription_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    duration_months INTEGER NOT NULL DEFAULT 1 CHECK (duration_months > 0),
    price_allocated NUMERIC NOT NULL DEFAULT 0 CHECK (price_allocated >= 0),
    is_used BOOLEAN NOT NULL DEFAULT FALSE,
    used_by_vendor_id UUID REFERENCES public.vendors(id) ON DELETE SET NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS subscription_codes_used_vendor_idx
    ON public.subscription_codes (used_by_vendor_id);

COMMIT;
