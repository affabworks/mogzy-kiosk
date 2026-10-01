-- أول تشغيل: شركة Woods + حساب المدير + موظفين تجريبيين.
-- قبل التشغيل: من Authentication > Users اضغط Add user، واكتب بريدك وكلمة سر، وفعّل Auto Confirm User.
-- بعدها بدّل البريد في السطر التالي بنفس بريدك وشغّل الملف كله في SQL Editor.
do $$
declare uid uuid; cid uuid;
begin
  select id into uid from auth.users where email = 'PUT-YOUR-EMAIL-HERE';
  if uid is null then raise exception 'المستخدم غير موجود: أنشئه من Authentication أولاً'; end if;
  insert into companies(name) values ('كافيه Woods') returning id into cid;
  insert into profiles(id, company_id, role, full_name, can_approve_leave, can_approve_advance)
    values (uid, cid, 'owner', 'مالك Woods', true, true);
  -- موظفون للتجربة (عدّل أو احذف): الاسم، المرتب الشهري، من/إلى
  insert into employees(company_id, full_name, phone, monthly_salary, shift_start, shift_end) values
    (cid, 'أحمد علي',   '01000000001', 6000, '09:00', '17:00'),
    (cid, 'محمود سعيد', '01000000002', 7000, '18:00', '02:00');
  raise notice 'تم. كود الشركة: %', (select code from companies where id = cid);
end $$;
