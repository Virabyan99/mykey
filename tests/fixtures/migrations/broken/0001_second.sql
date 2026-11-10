-- Fixture: creates a table, then fails. Nothing of it may remain.
CREATE TABLE fx.second (id integer PRIMARY KEY);
INSERT INTO fx.missing_table VALUES (1);
