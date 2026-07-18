-- Robayer WealthLab — D1 Migration 0010 (Version 2.0 Phase 3: Operational
-- Visibility — Consultation Manager, Contact Manager, Orders, Analytics)
--
-- See docs/v2.0-phase3-architecture-plan.md for the full design and
-- rationale. This migration ships the entire phase's schema needs in one
-- file (matching migration 0008's own precedent of front-loading a
-- phase's full table set even though the admin UI built on top of it
-- ships across several stages) — Orders and Analytics need zero schema
-- change at all (they read existing, unchanged tables), so this file's
-- only real content is the two small tables and two columns Consultation
-- Manager and Contact Manager genuinely need: an internal-notes thread
-- (a capability that does not exist anywhere in this schema today) and a
-- single-assignee column on each of the two existing request tables.
--
-- Every statement here is additive: 2 CREATE TABLE, 2 ALTER TABLE ADD
-- COLUMN, 4 CREATE INDEX. No DROP, no data migration, no table recreate
-- — the same safest-possible migration shape already used for 0006/0007's
-- additive portions.

-- ============================================================
-- CONSULTATION_NOTES
-- Internal, admin-authored notes on a consultation request. Append-only
-- by design (no UPDATE/DELETE code path is ever built for a note) —
-- mirrors audit_logs' own "don't rewrite history" philosophy. A separate
-- table from contact_notes (not one polymorphic "notes" table) for the
-- same reason consultation_requests and contact_messages are already two
-- distinct tables, not one.
-- ============================================================
CREATE TABLE consultation_notes (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  consultation_request_id INTEGER NOT NULL REFERENCES consultation_requests(id),
  author_id               INTEGER REFERENCES admin_users(id),
  note                    TEXT NOT NULL,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_consultation_notes_request ON consultation_notes(consultation_request_id);

-- ============================================================
-- CONTACT_NOTES
-- Same shape as consultation_notes, for contact_messages.
-- ============================================================
CREATE TABLE contact_notes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_message_id INTEGER NOT NULL REFERENCES contact_messages(id),
  author_id          INTEGER REFERENCES admin_users(id),
  note               TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_contact_notes_message ON contact_notes(contact_message_id);

-- ============================================================
-- Assignment — a single nullable column, not a join table. A
-- consultation/contact has at most one assignee at a time in this
-- brief's description; a many-to-many join table would be unjustified
-- complexity for a relationship that is never actually many-to-many in
-- a 1-3 person team.
-- ============================================================
ALTER TABLE consultation_requests ADD COLUMN assigned_to INTEGER REFERENCES admin_users(id);
ALTER TABLE contact_messages ADD COLUMN assigned_to INTEGER REFERENCES admin_users(id);

CREATE INDEX idx_consultation_requests_assigned_to ON consultation_requests(assigned_to);
CREATE INDEX idx_contact_messages_assigned_to ON contact_messages(assigned_to);
