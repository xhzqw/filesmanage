-- MAC is server-observed and optional; historical sessions remain unknown.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mac_address text NOT NULL DEFAULT '';
