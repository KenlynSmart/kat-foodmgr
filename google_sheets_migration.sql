CREATE TABLE IF NOT EXISTS public.google_sheet_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vendor_id UUID NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
    school_id UUID REFERENCES public.schools(id) ON DELETE CASCADE,
    sheet_name TEXT NOT NULL,
    sheet_url TEXT NOT NULL,
    sheet_id TEXT,
    sync_direction TEXT NOT NULL DEFAULT 'two_way',
    auto_sync_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    webhook_token TEXT NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
    last_synced_at TIMESTAMP WITH TIME ZONE,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.google_sheet_configs
    ADD COLUMN IF NOT EXISTS sheet_id TEXT,
    ADD COLUMN IF NOT EXISTS sync_direction TEXT DEFAULT 'two_way',
    ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS webhook_token TEXT,
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

UPDATE public.google_sheet_configs
SET webhook_token = encode(gen_random_bytes(24), 'hex')
WHERE webhook_token IS NULL OR webhook_token = '';

ALTER TABLE public.google_sheet_configs
    ALTER COLUMN webhook_token SET DEFAULT encode(gen_random_bytes(24), 'hex');

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'google_sheet_configs_sync_direction_check'
    ) THEN
        ALTER TABLE public.google_sheet_configs
            ADD CONSTRAINT google_sheet_configs_sync_direction_check
            CHECK (sync_direction IN ('two_way', 'push_to_sheet', 'pull_from_sheet'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS google_sheet_configs_vendor_idx
    ON public.google_sheet_configs(vendor_id);

CREATE INDEX IF NOT EXISTS google_sheet_configs_school_idx
    ON public.google_sheet_configs(school_id);
