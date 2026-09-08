-- Tabelle für alle eingehenden Kundenportal-Meldungen
create table if not exists meldungen (
    id bigint generated always as identity primary key,
    kategorie text not null check (kategorie in ('verschiebung', 'absage', 'reklamation', 'schaden', 'zusatz')),
    name text not null,
    objekt_id text not null,
    email text,
    details text,
    ip text,
    status text not null default 'neu' check (status in ('neu', 'akzeptieren', 'ablehnen', 'erledigt')),
    admin_note text,
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
