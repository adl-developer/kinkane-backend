-- Gives every existing account a username, generated from its display name.
--
-- Usernames arrived after everyone already had an account, and a mention can
-- only point at someone who has one, so every non-guest account gets a name
-- here. Same recipe as usernameBaseFromName in src/lib/username.ts — accents
-- dropped, a-z0-9 kept, at most 15 characters, `reader` when too little is left
-- or the result is reserved — then a number appended until it is free.
--
-- The two recipes cannot be the same code: the database has no unaccent
-- extension, so accents are mapped with translate() over the Latin-1 and
-- Latin Extended-A/B letters instead of Unicode decomposition. They agree on
-- every Latin name; where they could differ (some rarer script) the result is
-- still a valid, unique username, which is all this needs to guarantee. Anyone
-- can rename once at no cost — username_changed_at stays null here.
--
-- Guests are skipped: see the note on users.username.
--
-- Suffixes count up from 2 rather than being random like the app's. This runs
-- once, offline from any signup, and deterministic output is easier to check.

DO $$
DECLARE
  r record;
  base text;
  candidate text;
  n int;
  reserved text[] := ARRAY['about', 'account', 'admin', 'administrator', 'all', 'anonymous', 'api', 'app', 'books', 'community', 'contact', 'deleted', 'everyone', 'groups', 'guest', 'help', 'here', 'login', 'logout', 'me', 'mod', 'moderator', 'null', 'official', 'privacy', 'root', 'security', 'settings', 'signup', 'staff', 'support', 'system', 'team', 'terms', 'undefined', 'user', 'username', 'users', 'www'];
BEGIN
  FOR r IN SELECT id, name FROM users WHERE username IS NULL AND NOT is_guest ORDER BY id LOOP
    base := replace(replace(replace(replace(replace(replace(replace(r.name,
      'ß', 'ss'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'), 'þ', 'th'), 'Þ', 'th');
    base := translate(base, 'øØłŁđĐðÐ', 'oolldddd');
    base := translate(base,
      'ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿĀāĂăĄąĆćĈĉĊċČčĎďĒēĔĕĖėĘęĚěĜĝĞğĠġĢģĤĥĨĩĪīĬĭĮįİĴĵĶķĹĺĻļĽľŃńŅņŇňŌōŎŏŐőŔŕŖŗŘřŚśŜŝŞşŠšŢţŤťŨũŪūŬŭŮůŰűŲųŴŵŶŷŸŹźŻżŽžſƠơƯưǍǎǏǐǑǒǓǔǕǖǗǘǙǚǛǜǞǟǠǡǦǧǨǩǪǫǬǭǰǴǵǸǹǺǻȀȁȂȃȄȅȆȇȈȉȊȋȌȍȎȏȐȑȒȓȔȕȖȗȘșȚțȞȟȦȧȨȩȪȫȬȭȮȯȰȱȲȳ',
      'AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeGgGgGgGgHhIiIiIiIiIJjKkLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzsOoUuAaIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYy');
    -- lower() is ASCII-only under the C ctype, which is fine: nothing else is left.
    base := left(regexp_replace(lower(base), '[^a-z0-9]', '', 'g'), 15);

    IF length(base) < 3 OR base = ANY(reserved) OR position('kinkane' in base) > 0 THEN
      base := 'reader';
    END IF;

    candidate := base;
    n := 1;
    WHILE EXISTS (SELECT 1 FROM users WHERE username = candidate) LOOP
      n := n + 1;
      candidate := base || n;
    END LOOP;

    UPDATE users SET username = candidate WHERE id = r.id;
  END LOOP;
END $$;
