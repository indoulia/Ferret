-- EPIC-002 — bootstrap migration.
--
-- The `ferret` schema and the migrator's own bookkeeping tables are created by
-- the migrator before any migration runs (see `bookkeeping.ts`), because a
-- migration that fails must have somewhere to record that it failed. This file
-- therefore owns the first piece of real schema: the instance identity.
--
-- Instance identity distinguishes "an empty database" from "a database that is
-- not Ferret's" and gives EPIC-009 (Identity & Scope) a stable anchor that
-- survives re-indexing.

CREATE TABLE ferret.instance (
    -- One row, enforced by the primary key and the CHECK together.
    singleton   boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
    instance_id uuid        NOT NULL DEFAULT gen_random_uuid(),
    created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ferret.instance IS
    'Singleton identity for this Ferret database. Created by EPIC-002.';

INSERT INTO ferret.instance (singleton) VALUES (true);
