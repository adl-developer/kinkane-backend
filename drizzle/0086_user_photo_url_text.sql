-- Google profile photo URLs can be longer than 1,000 characters, and copying
-- one into a varchar(1000) failed the whole social sign-in with a 500.
ALTER TABLE "users" ALTER COLUMN "photo_url" SET DATA TYPE text;
