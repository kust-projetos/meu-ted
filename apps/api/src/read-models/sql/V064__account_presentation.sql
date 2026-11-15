ALTER TABLE accounts ADD COLUMN IF NOT EXISTS institution_id TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_product_id TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_institution_id_format_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_institution_id_format_check CHECK (institution_id IS NULL OR institution_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_card_product_id_format_check') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_card_product_id_format_check CHECK (card_product_id IS NULL OR card_product_id ~ '^[a-z0-9][a-z0-9._-]{0,63}$');
  END IF;
END $$;
