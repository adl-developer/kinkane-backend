-- The smallest catalogue the endpoint contract suite needs: one book, with a
-- genre and a contributor.
--
-- The suite reads real ids so parameterised routes exercise a row that exists,
-- not only their 404 path. The regression it was written for lived in the
-- found-a-row branch, so an empty CI database would test the wrong thing.
--
-- The ISBN uses the 979-8 prefix with an invented body; it is not meant to
-- match a real edition.
INSERT INTO books (record_reference, title, isbn13, long_description)
VALUES ('ci-fixture-0001', 'The Continuous Integration Reader', '9798000000001',
        'A fixture book. It exists so the endpoint contract suite has a row to read.');

INSERT INTO genres (name, slug) VALUES ('Fiction', 'fiction');

INSERT INTO book_genres (book_id, genre_id)
SELECT b.id, g.id FROM books b, genres g
WHERE b.record_reference = 'ci-fixture-0001' AND g.slug = 'fiction';

INSERT INTO book_contributors (book_id, sequence_number, role, person_name, person_name_inverted)
SELECT id, 1, 'A01', 'Ada Fixture', 'Fixture, Ada' FROM books WHERE record_reference = 'ci-fixture-0001';
