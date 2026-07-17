create extension if not exists pgcrypto;

do $$ begin create type contato_status as enum ('ativo','bloqueado','invalido','descadastrado'); exception when duplicate_object then null; end $$;
do $$ begin create type campanha_status as enum ('rascunho','ativa','pausada','concluida'); exception when duplicate_object then null; end $$;
do $$ begin create type fila_status as enum ('pendente','processando','enviado','entregue','lido','falhou','cancelado','bloqueado_custo'); exception when duplicate_object then null; end $$;

create table if not exists configuracoes (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone_number_id text unique,
  limite_diario integer not null default 50 check (limite_diario between 1 and 200),
  modo_custo_zero boolean not null default true,
  criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now()
);
create table if not exists contatos (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null check (char_length(nome) between 1 and 120), numero_whatsapp text not null check (numero_whatsapp ~ '^[1-9][0-9]{9,14}$'),
  status contato_status not null default 'ativo', consentimento_em timestamptz, consentimento_origem text,
  ultima_mensagem_recebida_em timestamptz, janela_atendimento_ate timestamptz, descadastrado_em timestamptz,
  data_criacao timestamptz not null default now(), unique(user_id, numero_whatsapp)
);
create table if not exists campanhas (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  nome text not null, template_mensagem text not null check (char_length(template_mensagem) between 1 and 4096),
  status campanha_status not null default 'rascunho', criado_em timestamptz not null default now()
);
create table if not exists fila_envios (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  contato_id uuid not null references contatos(id) on delete restrict, campanha_id uuid references campanhas(id) on delete set null,
  mensagem_final text not null check (char_length(mensagem_final) between 1 and 4096), agendado_para timestamptz not null default now(),
  status fila_status not null default 'pendente', erro_log text, tentativas integer not null default 0,
  meta_message_id text unique, worker_id uuid, processando_em timestamptz, enviado_em timestamptz, criado_em timestamptz not null default now()
);
create table if not exists webhook_eventos (
  id uuid primary key default gen_random_uuid(), payload jsonb not null, recebido_em timestamptz not null default now()
);
create index if not exists fila_pendente_idx on fila_envios(status, agendado_para) where status = 'pendente';
create index if not exists fila_user_data_idx on fila_envios(user_id, criado_em desc);
create index if not exists contatos_phone_idx on contatos(numero_whatsapp);

alter table configuracoes enable row level security; alter table contatos enable row level security;
alter table campanhas enable row level security; alter table fila_envios enable row level security; alter table webhook_eventos enable row level security;
drop policy if exists own_config on configuracoes; create policy own_config on configuracoes for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists own_contacts on contatos; create policy own_contacts on contatos for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists own_campaigns on campanhas; create policy own_campaigns on campanhas for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
drop policy if exists own_queue on fila_envios; create policy own_queue on fila_envios for all using (auth.uid()=user_id) with check (auth.uid()=user_id);

create or replace function enforce_queue_ownership() returns trigger language plpgsql security definer set search_path=public as $$
declare c_user uuid; c_status contato_status; c_consent timestamptz;
begin
  select user_id,status,consentimento_em into c_user,c_status,c_consent from contatos where id=new.contato_id;
  if c_user is null or c_user <> new.user_id then raise exception 'Contato não pertence ao usuário'; end if;
  if c_status <> 'ativo' then raise exception 'Contato não está ativo'; end if;
  if c_consent is null then raise exception 'Consentimento obrigatório'; end if;
  if new.campanha_id is not null and not exists(select 1 from campanhas where id=new.campanha_id and user_id=new.user_id) then raise exception 'Campanha inválida'; end if;
  return new;
end $$;
drop trigger if exists trg_queue_ownership on fila_envios;
create trigger trg_queue_ownership before insert or update of contato_id,campanha_id,user_id on fila_envios for each row execute function enforce_queue_ownership();

create or replace function claim_next_send(p_worker_id uuid)
returns table(id uuid,user_id uuid,numero_whatsapp text,mensagem_final text,janela_atendimento_ate timestamptz,limite_diario integer)
language plpgsql security definer set search_path=public as $$
declare q fila_envios%rowtype;
begin
  select f.* into q from fila_envios f
  where (f.status='pendente' or (f.status='processando' and f.processando_em < now()-interval '5 minutes')) and f.agendado_para<=now()
    and (select count(*) from fila_envios x where x.user_id=f.user_id and x.enviado_em >= date_trunc('day',now()))
        < coalesce((select c.limite_diario from configuracoes c where c.user_id=f.user_id),50)
  order by f.agendado_para for update skip locked limit 1;
  if q.id is null then return; end if;
  update fila_envios set status='processando',worker_id=p_worker_id,processando_em=now(),tentativas=tentativas+1 where fila_envios.id=q.id;
  return query select q.id,q.user_id,c.numero_whatsapp,q.mensagem_final,c.janela_atendimento_ate,coalesce(cfg.limite_diario,50)
    from contatos c left join configuracoes cfg on cfg.user_id=q.user_id where c.id=q.contato_id;
end $$;
revoke all on function claim_next_send(uuid) from public,anon,authenticated; grant execute on function claim_next_send(uuid) to service_role;

create or replace function register_whatsapp_webhook(p_payload jsonb) returns void language plpgsql security definer set search_path=public as $$
declare v jsonb; m jsonb; s jsonb; owner_id uuid; phone_id text; from_number text; msg_id text; event_status text; inbound_text text;
begin
  insert into webhook_eventos(payload) values(p_payload);
  for v in select value from jsonb_array_elements(coalesce(p_payload->'entry','[]'::jsonb)) loop
    for v in select value from jsonb_array_elements(coalesce(v->'changes','[]'::jsonb)) loop
      phone_id := v#>>'{value,metadata,phone_number_id}'; select user_id into owner_id from configuracoes where phone_number_id=phone_id;
      if owner_id is null then continue; end if;
      for m in select value from jsonb_array_elements(coalesce(v#>'{value,messages}','[]'::jsonb)) loop
        from_number:=m->>'from'; msg_id:=m->>'id'; inbound_text:=upper(trim(coalesce(m#>>'{text,body}','')));
        insert into contatos(user_id,nome,numero_whatsapp,status,consentimento_em,consentimento_origem,ultima_mensagem_recebida_em,janela_atendimento_ate)
        values(owner_id,coalesce(v#>>'{value,contacts,0,profile,name}',from_number),from_number,'ativo',now(),'Mensagem iniciada pelo cliente',now(),now()+interval '24 hours')
        on conflict(user_id,numero_whatsapp) do update set ultima_mensagem_recebida_em=now(),janela_atendimento_ate=now()+interval '24 hours';
        if inbound_text in ('SAIR','PARAR','CANCELAR','REMOVER') then
          update contatos set status='descadastrado',descadastrado_em=now(),janela_atendimento_ate=null
          where user_id=owner_id and numero_whatsapp=from_number;
          update fila_envios set status='cancelado',erro_log='Cancelado por solicitação de descadastro.'
          where user_id=owner_id and contato_id=(select id from contatos where user_id=owner_id and numero_whatsapp=from_number) and status='pendente';
        end if;
      end loop;
      for s in select value from jsonb_array_elements(coalesce(v#>'{value,statuses}','[]'::jsonb)) loop
        msg_id:=s->>'id'; event_status:=s->>'status';
        update fila_envios set status=case event_status when 'delivered' then 'entregue'::fila_status when 'read' then 'lido'::fila_status when 'failed' then 'falhou'::fila_status else status end,
          erro_log=case when event_status='failed' then left(s::text,2000) else erro_log end where meta_message_id=msg_id;
      end loop;
    end loop;
  end loop;
end $$;
revoke all on function register_whatsapp_webhook(jsonb) from public,anon,authenticated; grant execute on function register_whatsapp_webhook(jsonb) to service_role;
