-- Capture the marketing site's concept_feedback table into version control.
--
-- This table was created by hand in the Supabase dashboard and had no migration
-- in either repository. It is the durable source of truth for the marketing
-- site's /api/concept-feedback route, so losing it loses real submissions.
--
-- Every statement is idempotent: on the existing production database this
-- migration is a no-op, while a fresh or reset database reproduces the table
-- exactly as it stands today (columns, checks, indexes, RLS posture).
--
-- Access model: RLS is ENABLED with no policies and no grants to anon or
-- authenticated. Only the service role reaches this table, which is how the
-- marketing site writes it. Do not add a policy without an explicit decision.

create table if not exists public.concept_feedback (
    id uuid not null default gen_random_uuid() primary key,
    created_at timestamp with time zone not null default now(),
    concept_slug text not null,
    concept_name text not null,
    reviewer_name text not null,
    reviewer_email text not null,
    reviewer_role text,
    reviewer_company text,
    reviewer_type text not null,
    rating smallint not null,
    feels_like_elect text not null,
    buyers_respect text not null,
    what_works text,
    whats_missing text,
    user_agent text,
    request_id text,
    constraint concept_feedback_reviewer_type_check check (reviewer_type = any (array['sean'::text, 'team'::text, 'forwarded'::text])),
    constraint concept_feedback_rating_check check (rating >= 1 and rating <= 5),
    constraint concept_feedback_feels_like_elect_check check (feels_like_elect = any (array['yes'::text, 'sort-of'::text, 'no'::text])),
    constraint concept_feedback_buyers_respect_check check (buyers_respect = any (array['yes'::text, 'maybe'::text, 'no'::text]))
);

create index if not exists concept_feedback_slug_created_idx
    on public.concept_feedback using btree (concept_slug, created_at desc);

create index if not exists concept_feedback_type_created_idx
    on public.concept_feedback using btree (reviewer_type, created_at desc);

alter table public.concept_feedback enable row level security;
