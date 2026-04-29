-- Lihat semua CHECK constraint di seo_content_briefs
SELECT
  con.conname     AS constraint_name,
  pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class       rel ON rel.oid = con.conrelid
JOIN pg_namespace   nsp ON nsp.oid = rel.relnamespace
WHERE rel.relname = 'seo_content_briefs'
  AND con.contype = 'c'   -- 'c' = CHECK constraint
ORDER BY con.conname;

-- Bonus: lihat semua brief_type values yang udah ever exist
SELECT brief_type, COUNT(*)
FROM seo_content_briefs
GROUP BY brief_type
ORDER BY COUNT(*) DESC;

-- Bonus 2: lihat trigger di table ini (kalau ada constraint via trigger)
SELECT
  trigger_name,
  event_manipulation,
  action_timing,
  action_statement
FROM information_schema.triggers
WHERE event_object_table = 'seo_content_briefs';
