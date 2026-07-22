ALTER TABLE public.vendors
    ADD COLUMN IF NOT EXISTS company_full_name TEXT
        DEFAULT 'CHI NHÁNH CÔNG TY CP VN FOOD - NEP MART',
    ADD COLUMN IF NOT EXISTS address TEXT
        DEFAULT 'Lô 23-24 khu B2-87, KĐT ven sông Hòa Quý - Đồng Nò, Hòa Quý, Ngũ Hành Sơn, Đà Nẵng',
    ADD COLUMN IF NOT EXISTS hotline TEXT DEFAULT '085.728.0282',
    ADD COLUMN IF NOT EXISTS tax_code TEXT,
    ADD COLUMN IF NOT EXISTS default_creator_name TEXT DEFAULT 'Thủ kho VNFS',
    ADD COLUMN IF NOT EXISTS print_show_price_default BOOLEAN DEFAULT TRUE;

ALTER TABLE public.schools
    ADD COLUMN IF NOT EXISTS school_code TEXT,
    ADD COLUMN IF NOT EXISTS full_name TEXT,
    ADD COLUMN IF NOT EXISTS address TEXT,
    ADD COLUMN IF NOT EXISTS contact_phone TEXT,
    ADD COLUMN IF NOT EXISTS default_receiver_name TEXT,
    ADD COLUMN IF NOT EXISTS has_teacher_order BOOLEAN DEFAULT TRUE;

UPDATE public.vendors
SET
    company_full_name = COALESCE(company_full_name, name),
    default_creator_name = COALESCE(default_creator_name, 'Thủ kho VNFS'),
    print_show_price_default = COALESCE(print_show_price_default, TRUE)
WHERE company_full_name IS NULL
   OR default_creator_name IS NULL
   OR print_show_price_default IS NULL;

UPDATE public.schools
SET
    school_code = COALESCE(NULLIF(school_code, ''), code),
    full_name = COALESCE(NULLIF(full_name, ''), name),
    has_teacher_order = COALESCE(has_teacher_order, TRUE)
WHERE school_code IS NULL
   OR school_code = ''
   OR full_name IS NULL
   OR full_name = ''
   OR has_teacher_order IS NULL;

CREATE INDEX IF NOT EXISTS vendors_print_profile_idx
    ON public.vendors (id);

CREATE INDEX IF NOT EXISTS schools_school_code_idx
    ON public.schools (vendor_id, school_code);
