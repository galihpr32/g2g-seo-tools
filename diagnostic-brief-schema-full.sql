-- ─────────────────────────────────────────────────────────────────
-- Lihat seluruh schema seo_content_briefs sekaligus:
--   1. Kolom + nullability + default
--   2. CHECK constraints (eksplisit)
--   3. NOT NULL constraints
-- Run masing-masing query SECARA TERPISAH (highlight + Run selection)
-- biar hasilnya nampak satu per satu.
-- ─────────────────────────────────────────────────────────────────

-- (1) Kolom + nullability + default
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'seo_content_briefs'
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- (2) CHECK constraints (lengkap dengan definisi)
SELECT
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class      rel ON rel.oid = con.conrelid
JOIN pg_namespace  nsp ON nsp.oid = rel.relnamespace
WHERE rel.relname = 'seo_content_briefs'
  AND con.contype = 'c'
ORDER BY con.conname;

-- (3) NOT NULL constraints (kalau ada via constraint, bukan column-level)
SELECT
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class      rel ON rel.oid = con.conrelid
WHERE rel.relname = 'seo_content_briefs'
  AND con.contype IN ('n', 'p', 'u', 'f')
ORDER BY con.contype, con.conname;
