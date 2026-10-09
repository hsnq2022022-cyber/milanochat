-- يمنع المستخدم من إدراج طلب بحالة مدفوعة أو ببيانات دفع مزوّرة من المتصفح.
-- الدوال (service_role) والإدراج المباشر من قاعدة البيانات لا يتأثران.

create or replace function public.orders_force_safe_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.status         := 'pending';
    new.paid_at        := null;
    new.wayl_code      := null;
    new.wayl_url       := null;
    new.payment_method := null;
    new.webhook_data   := null;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_force_safe_insert on public.orders;

create trigger orders_force_safe_insert
before insert on public.orders
for each row execute function public.orders_force_safe_insert();

create index if not exists orders_wayl_code_idx on public.orders (wayl_code);
