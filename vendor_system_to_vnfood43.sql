BEGIN;

DO $migration$
DECLARE
    v_old_id UUID;
    v_new_id UUID;
    v_source_code TEXT;
    v_target_code TEXT;
BEGIN
    SELECT id, code
    INTO v_old_id, v_source_code
    FROM public.vendors
    WHERE lower(code) = 'system' OR lower(name) = 'system'
    ORDER BY (lower(code) = 'system') DESC
    LIMIT 1;

    IF v_old_id IS NULL THEN
        RAISE NOTICE 'Source vendor "system" was not found; nothing to migrate.';
        RETURN;
    END IF;

    SELECT id, code
    INTO v_new_id, v_target_code
    FROM public.vendors
    WHERE lower(code) = 'vnfood43' OR lower(name) = 'vnfood43'
    ORDER BY (lower(code) = 'vnfood43') DESC
    LIMIT 1;

    IF v_new_id IS NULL THEN
        INSERT INTO public.vendors (code, name, status)
        VALUES ('vnfood43', 'vnfood43', 'active')
        RETURNING id, code INTO v_new_id, v_target_code;
    END IF;

    IF v_old_id = v_new_id THEN
        RAISE EXCEPTION 'Source and target vendors resolve to the same row (%).', v_old_id;
    END IF;

    RAISE NOTICE 'Migrating vendor % (%) to % (%).', v_source_code, v_old_id, v_target_code, v_new_id;

    /*
     * Categories are referenced by products. Keep the target row when the
     * vendor/name key already exists, then re-link products before deleting
     * the source duplicate.
     */
    UPDATE public.products source_products
    SET category_id = target_categories.id
    FROM public.categories source_categories
    JOIN public.categories target_categories
      ON target_categories.vendor_id = v_new_id
     AND lower(target_categories.name) = lower(source_categories.name)
    WHERE source_categories.vendor_id = v_old_id
      AND source_products.vendor_id = v_old_id
      AND source_products.category_id = source_categories.id;

    DELETE FROM public.categories source_categories
    USING public.categories target_categories
    WHERE source_categories.vendor_id = v_old_id
      AND target_categories.vendor_id = v_new_id
      AND lower(target_categories.name) = lower(source_categories.name);

    UPDATE public.categories
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    /*
     * Re-link duplicate products before touching orders and stock.
     */
    UPDATE public.stock source_stock
    SET product_id = target_products.id
    FROM public.products source_products
    JOIN public.products target_products
      ON target_products.vendor_id = v_new_id
     AND lower(target_products.code) = lower(source_products.code)
    WHERE source_stock.vendor_id = v_old_id
      AND source_products.vendor_id = v_old_id
      AND source_stock.product_id = source_products.id;

    UPDATE public.daily_orders source_orders
    SET product_id = target_products.id
    FROM public.products source_products
    JOIN public.products target_products
      ON target_products.vendor_id = v_new_id
     AND lower(target_products.code) = lower(source_products.code)
    WHERE source_orders.vendor_id = v_old_id
      AND source_products.vendor_id = v_old_id
      AND source_orders.product_id = source_products.id;

    DELETE FROM public.products source_products
    USING public.products target_products
    WHERE source_products.vendor_id = v_old_id
      AND target_products.vendor_id = v_new_id
      AND lower(target_products.code) = lower(source_products.code);

    /*
     * Schools use the same re-link pattern because daily_orders reference
     * school IDs.
     */
    UPDATE public.daily_orders source_orders
    SET school_id = target_schools.id
    FROM public.schools source_schools
    JOIN public.schools target_schools
      ON target_schools.vendor_id = v_new_id
     AND lower(target_schools.code) = lower(source_schools.code)
    WHERE source_orders.vendor_id = v_old_id
      AND source_schools.vendor_id = v_old_id
      AND source_orders.school_id = source_schools.id;

    DELETE FROM public.schools source_schools
    USING public.schools target_schools
    WHERE source_schools.vendor_id = v_old_id
      AND target_schools.vendor_id = v_new_id
      AND lower(target_schools.code) = lower(source_schools.code);

    /*
     * A product/school re-link can create duplicate daily-order keys. Merge
     * those rows by keeping the target order, adding quantities, moving the
     * batch ledger, and deleting the source order.
     */
    UPDATE public.daily_order_batches source_batches
    SET daily_order_id = target_orders.id,
        vendor_id = v_new_id
    FROM public.daily_orders source_orders
    JOIN public.daily_orders target_orders
      ON target_orders.vendor_id = v_new_id
     AND target_orders.delivery_date = source_orders.delivery_date
     AND target_orders.product_id = source_orders.product_id
     AND target_orders.school_id = source_orders.school_id
    WHERE source_orders.vendor_id = v_old_id
      AND source_batches.daily_order_id = source_orders.id;

    WITH duplicate_orders AS (
        SELECT source_orders.id AS source_id, target_orders.id AS target_id
        FROM public.daily_orders source_orders
        JOIN public.daily_orders target_orders
          ON target_orders.vendor_id = v_new_id
         AND target_orders.delivery_date = source_orders.delivery_date
         AND target_orders.product_id = source_orders.product_id
         AND target_orders.school_id = source_orders.school_id
        WHERE source_orders.vendor_id = v_old_id
    )
    UPDATE public.daily_orders target_orders
    SET qty = target_orders.qty + duplicate_orders.source_qty
    FROM (
        SELECT duplicate_orders.target_id,
               sum(source_orders.qty) AS source_qty
        FROM duplicate_orders
        JOIN public.daily_orders source_orders
          ON source_orders.id = duplicate_orders.source_id
        GROUP BY duplicate_orders.target_id
    ) duplicate_orders
    WHERE target_orders.id = duplicate_orders.target_id;

    DELETE FROM public.daily_orders source_orders
    USING public.daily_orders target_orders
    WHERE source_orders.vendor_id = v_old_id
      AND target_orders.vendor_id = v_new_id
      AND target_orders.delivery_date = source_orders.delivery_date
      AND target_orders.product_id = source_orders.product_id
      AND target_orders.school_id = source_orders.school_id;

    /*
     * Stock has one row per vendor/product. Combine quantities when both
     * vendors already have stock for the same product.
     */
    UPDATE public.stock target_stock
    SET qty = target_stock.qty + source_stock.qty
    FROM public.stock source_stock
    WHERE source_stock.vendor_id = v_old_id
      AND target_stock.vendor_id = v_new_id
      AND target_stock.product_id = source_stock.product_id;

    DELETE FROM public.stock source_stock
    USING public.stock target_stock
    WHERE source_stock.vendor_id = v_old_id
      AND target_stock.vendor_id = v_new_id
      AND target_stock.product_id = source_stock.product_id;

    /*
     * Usernames are globally unique and users have no tenant child ledger.
     * Refuse an ambiguous merge rather than silently deleting an account.
     */
    IF EXISTS (
        SELECT 1
        FROM public.users source_users
        JOIN public.users target_users
          ON lower(target_users.username) = lower(source_users.username)
         AND target_users.vendor_id = v_new_id
        WHERE source_users.vendor_id = v_old_id
          AND source_users.id <> target_users.id
    ) THEN
        RAISE EXCEPTION
            'Cannot merge users: source and target vendors contain the same username.';
    END IF;

    UPDATE public.users
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    UPDATE public.schools
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    UPDATE public.products
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    UPDATE public.stock
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    UPDATE public.daily_orders
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    UPDATE public.daily_order_batches
    SET vendor_id = v_new_id
    WHERE vendor_id = v_old_id;

    IF EXISTS (
        SELECT 1
        FROM public.users
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.categories
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.schools
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.products
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.stock
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.daily_orders
        WHERE vendor_id = v_old_id
    ) OR EXISTS (
        SELECT 1
        FROM public.daily_order_batches
        WHERE vendor_id = v_old_id
    ) THEN
        RAISE EXCEPTION 'Source vendor still owns rows after migration.';
    END IF;
END
$migration$;

COMMIT;

SELECT 'users' AS table_name, count(*) AS remaining_rows
FROM public.users
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'categories', count(*)
FROM public.categories
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'schools', count(*)
FROM public.schools
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'products', count(*)
FROM public.products
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'stock', count(*)
FROM public.stock
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'daily_orders', count(*)
FROM public.daily_orders
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system')
UNION ALL
SELECT 'daily_order_batches', count(*)
FROM public.daily_order_batches
WHERE vendor_id = (SELECT id FROM public.vendors WHERE lower(code) = 'system' OR lower(name) = 'system');

SELECT count(*) AS orphan_daily_orders
FROM public.daily_orders orders
LEFT JOIN public.products products ON products.id = orders.product_id
LEFT JOIN public.schools schools ON schools.id = orders.school_id
WHERE products.id IS NULL OR schools.id IS NULL;
