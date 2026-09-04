-- ═══════════════════════════════════════════════════════════════════════════
-- Milano — Supabase schema (pgvector + RLS)
-- نفّذ هذا الملف كاملاً في Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ── العملاء (المشاريع المشتركة) ──────────────────────────────────────────────
create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete set null, -- يُربط بعد التسجيل
  claim_token     text unique not null default encode(gen_random_bytes(16), 'hex'),
  business_name   text not null,
  source_type     text not null check (source_type in ('gmaps','website','manual')),
  source_url      text,
  phone_encrypted text,                 -- رقم واتساب المشروع (مشفر AES-GCM عند الراحة)
  credits_remaining integer not null default 0,
  is_active       boolean not null default false,  -- تتفعل بعد تأكيد الدفع من الـ webhook
  activated_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- ── مصادر المعرفة ────────────────────────────────────────────────────────────
create table public.knowledge_sources (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  kind               text not null check (kind in ('url','text')),
  url                text,
  raw_text_encrypted text,              -- النص الخام مشفر عند الراحة
  status             text not null default 'pending' check (status in ('pending','indexed','failed')),
  error              text,
  chunks_count       integer not null default 0,
  created_at         timestamptz not null default now()
);

-- ── قطع المعرفة + الـ embeddings ─────────────────────────────────────────────
create table public.knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  source_id   uuid references public.knowledge_sources(id) on delete cascade,
  chunk_index integer not null default 0,
  content     text not null,
  embedding   vector(1536),             -- عدّل البعد إن استخدمت موديل embeddings آخر
  created_at  timestamptz not null default now()
);
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunks_tenant_idx
  on public.knowledge_chunks (tenant_id);

-- ── المحادثات ────────────────────────────────────────────────────────────────
create table public.conversations (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references public.tenants(id) on delete cascade,
  wa_chat_id             text not null,
  customer_phone_encrypted text not null,          -- مشفر عند الراحة
  transferred            boolean not null default false,  -- محوّلة لموظف بشري
  auto_paused_reason     text,                     -- 'credits' | 'manual' | null
  last_message_at        timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  unique (tenant_id, wa_chat_id)
);
create index if not exists conversations_tenant_idx on public.conversations (tenant_id, last_message_at desc);

-- ── الرسائل ──────────────────────────────────────────────────────────────────
create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  direction       text not null check (direction in ('in','out')),
  body_encrypted  text not null,                   -- المحتوى مشفر عند الراحة
  kind            text not null default 'answer'
                  check (kind in ('customer','answer','refusal','handoff','manual')),
  is_auto         boolean not null default false,
  wa_message_id   text,
  created_at      timestamptz not null default now()
);
create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at desc);

-- ── سجل الأسئلة العالقة (ما لقى لها إجابة مؤكدة) ────────────────────────────
create table public.unresolved_questions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  conversation_id   uuid references public.conversations(id) on delete cascade,
  question_encrypted text not null,
  status            text not null default 'open' check (status in ('open','resolved')),
  manual_answer     text,
  added_to_kb       boolean not null default false,
  best_similarity   real,               -- أعلى درجة تشابه دلالي حققها السؤال (تشخيص العتبة)
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);

-- ── المدفوعات ────────────────────────────────────────────────────────────────
create table public.payments (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  provider        text not null default 'moyasar',  -- جاهز للتوسع: tap / paytabs
  invoice_id      text unique,
  amount          integer not null,                 -- بالهللة (9900 = 99 ريال)
  currency        text not null default 'SAR',
  status          text not null default 'created' check (status in ('created','paid','failed','refunded')),
  credits_granted integer not null default 0,
  webhook_event   jsonb,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz
);

-- ── دفتر الخصم (يمنع الازدواج) ───────────────────────────────────────────────
create table public.reply_ledger (
  id         bigserial primary key,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  message_id uuid not null unique references public.messages(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ═══ دوال ════════════════════════════════════════════════════════════════════

-- خصم رد واحد بشكل ذرّي؛ لا خصم مكرر ولا نزول تحت الصفر
create or replace function public.consume_reply(p_tenant_id uuid, p_message_id uuid)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  insert into public.reply_ledger (tenant_id, message_id)
  values (p_tenant_id, p_message_id)
  on conflict (message_id) do nothing;
  if not found then
    return -2; -- سبق خصم هذه الرسالة
  end if;

  update public.tenants
     set credits_remaining = credits_remaining - 1
   where id = p_tenant_id and credits_remaining > 0
  returning credits_remaining into v_remaining;

  if not found then
    return -1; -- نفد الرصيد
  end if;

  return v_remaining;
end;
$$;

-- منح رصيد بعد دفع مؤكد (يُستدعى من webhook فقط)
create or replace function public.grant_credits(p_tenant_id uuid, p_credits integer)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.tenants
     set credits_remaining = credits_remaining + p_credits,
         is_active = true,
         activated_at = coalesce(activated_at, now())
   where id = p_tenant_id;
end;
$$;

-- بحث دلالي معزول لكل عميل
create or replace function public.match_knowledge(
  p_tenant_id uuid,
  p_query     vector(1536),
  p_limit     integer default 6,
  p_threshold real    default 0.25
)
returns table (id uuid, content text, similarity real)
language sql stable security definer set search_path = public
as $$
  select kc.id, kc.content, 1 - (kc.embedding <=> p_query)::real as similarity
    from public.knowledge_chunks kc
   where kc.tenant_id = p_tenant_id
     and kc.embedding is not null
     and 1 - (kc.embedding <=> p_query) > p_threshold
   order by kc.embedding <=> p_query
   limit p_limit;
$$;

-- ═══ RLS (السيرفر يستخدم service role؛ السياسات حماية لأي وصول مباشر مستقبلي) ══

alter table public.tenants               enable row level security;
alter table public.knowledge_sources     enable row level security;
alter table public.knowledge_chunks      enable row level security;
alter table public.conversations         enable row level security;
alter table public.messages              enable row level security;
alter table public.unresolved_questions  enable row level security;
alter table public.payments              enable row level security;
alter table public.reply_ledger          enable row level security;

create policy tenants_owner_all on public.tenants
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy tenants_claim_link on public.tenants
  for update using (claim_token is not null);

create policy sources_owner on public.knowledge_sources
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy chunks_owner on public.knowledge_chunks
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy conversations_owner on public.conversations
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy messages_owner on public.messages
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy unresolved_owner on public.unresolved_questions
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy payments_owner on public.payments
  for all using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));

create policy ledger_owner on public.reply_ledger
  for select using (exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid()));
