-- Issued and reset credentials no longer require a forced second rotation.
-- Preserve password hashing, administrative reset and session revocation.
ALTER TABLE users ALTER COLUMN must_change_password SET DEFAULT false;
UPDATE users SET must_change_password=false WHERE must_change_password=true;
