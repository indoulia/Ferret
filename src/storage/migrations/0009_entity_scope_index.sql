-- EPIC-032's reconciliation joins `entity` on `source_scope`, and nothing
-- indexed it, so every run scanned the whole table. CI caught it as an
-- incremental index run becoming slower than the full one it followed.
--
-- Also serves `findEntities(scope)` — "every file in this repository".

CREATE INDEX "entity_scope_idx" ON "ferret"."entity" ("source_scope", "kind");
