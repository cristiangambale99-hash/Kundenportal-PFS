-- Tabelle für alle eingehenden Kundenportal-Meldungen
create table if not exists meldungen (
    id bigint generated always as identity primary key,
    kategorie text not null check (kategorie in ('verschiebung', 'absage', 'reklamation', 'schaden', 'zusatz')),
    name text not null,
    objekt_id text,
    adresse text,
    email text,
    details text,
    ip text,
    status text not null default 'neu' check (status in ('neu', 'akzeptieren', 'ablehnen', 'erledigt')),
    admin_note text,
    zuordnung_offen boolean not null default false,
    created_at timestamptz not null default now()
);

-- Protokoll fehlgeschlagener/abgelehnter Versuche, für das Analytics-Dashboard
-- im Admin-Bereich (z.B. wie oft schlägt das Captcha fehl, wie oft eine
-- unbekannte Objektnummer etc.)
create table if not exists fehlversuche (
    id bigint generated always as identity primary key,
    kategorie text,
    grund text not null,
    ip text,
    created_at timestamptz not null default now()
);

-- Zuordnungstabelle: Aduna-Objekt <-> Beekeeper-Gruppenchat
-- (wird wöchentlich per match_objekte_zu_beekeeper.py aktualisiert; dient
-- ausserdem als Referenzliste gültiger Objekt-/Kundennummern fürs Portal)
create table if not exists objekt_beekeeper_mapping (
    objekt_id text primary key,
    kunde text not null,
    beekeeper_chat_id text,
    status text not null check (status in ('matched', 'unmatched', 'ambiguous')),
    updated_at timestamptz not null default now()
);

create index if not exists idx_meldungen_objekt_id on meldungen (objekt_id);
create index if not exists idx_meldungen_created_at on meldungen (created_at desc);
create index if not exists idx_meldungen_ip_created on meldungen (ip, created_at desc);
create index if not exists idx_meldungen_status on meldungen (status);
create index if not exists idx_fehlversuche_created on fehlversuche (created_at desc);

-- Nachträglich für bestehende Installationen (einmalig ausführen, Fehler bei
-- bereits vorhandenen Spalten sind unkritisch):
alter table meldungen alter column objekt_id drop not null;
alter table meldungen add column if not exists adresse text;
alter table meldungen add column if not exists zuordnung_offen boolean not null default false;
create index if not exists idx_meldungen_zuordnung on meldungen (zuordnung_offen) where zuordnung_offen;
