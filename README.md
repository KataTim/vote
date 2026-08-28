# VoteZone 2000 — 投票站（GitHub Pages + Supabase）

千禧年 / Windows 98 风格的静态投票网站。纯前端（HTML + CSS + JS），
可直接部署到 GitHub Pages，数据全部通过 Supabase 提供。

## 项目结构

```
index.html          首页 - 公开投票列表
login.html           登录
register.html        注册
vote.html             投票详情 / 投票 / 结果
admin.html           管理后台（仅 is_admin=true 可用）
404.html               让 /vote/2937739 这种"好看的" URL 在 GitHub Pages 上也能用
css/style.css       在 98.css 基础上的站点样式，含移动端适配
js/supabase.js     唯一的 Supabase client 初始化（window.sb）
js/utils.js           日期格式化 / 投票状态计算 / 错误信息中文化
js/auth.js             登录状态监听 + 顶部工具条渲染 + 管理员跳转校验
js/index.js           首页逻辑
js/login.js            登录逻辑
js/register.js       注册逻辑
js/vote.js             投票详情页逻辑
js/admin.js           管理后台逻辑
```

所有页面共用同一个 Supabase client（`js/supabase.js` 里的 `window.sb`），
没有在任何地方重复 `createClient()`，也没有写入 service_role key —— 用
的是你提供的 Publishable Key，这个 key 就是设计给浏览器用的，可以公开。

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库（例如 `USERNAME.github.io`，或任意仓库名 + 开启 Project Pages）。
2. 把本项目所有文件（含 `css/`、`js/`、`404.html`）提交到仓库根目录（如果是
   User Page 仓库 `USERNAME.github.io`，文件放根目录；如果是普通仓库开
   Project Pages，文件也放根目录，GitHub Pages 会以仓库根作为站点根）。
3. 仓库 Settings → Pages → Build and deployment → Source 选择
   `Deploy from a branch`，分支选 `main`（或你使用的分支），目录选 `/ (root)`。
4. 保存后等待几分钟，访问 `https://USERNAME.github.io/`。
5. 分享投票链接时可以直接用 `https://USERNAME.github.io/vote/2937739`；
   GitHub Pages 找不到这个路径时会回退到 `404.html`，`404.html` 里的脚本
   会自动把它跳转到 `vote.html?id=2937739`。站内的"进入投票"按钮直接链
   接到 `vote.html?id=2937739`，加载更快、不用经过一次跳转。

> 注意：Supabase 项目的 Authentication → URL Configuration 里，建议把
> `https://USERNAME.github.io` 加入 Site URL / Redirect URLs 白名单
> （虽然本项目没有用到邮箱确认跳转或 OAuth，但养成习惯，未来若开启这
> 些功能会更顺畅）。

## ⚠️ 部署前必须在 Supabase 执行的 SQL

你已经建好了表结构，我没有改动任何一张表的字段。但要让本项目的功能
"既能用、又安全"（管理员权限、投票唯一性、结果统计都必须由数据库而
不是前端 JS 来把关），还需要在 Supabase 的 SQL Editor 里补充下面这些
**RLS 策略、一个触发器、一个函数**。这些都是"新增"，不会删除你现有
的表或字段。请通读一遍再执行。

```sql
-- =========================================================
-- 0. 确保开启 RLS（如果已经开了，重复执行也没问题）
-- =========================================================
alter table profiles enable row level security;
alter table polls enable row level security;
alter table poll_options enable row level security;
alter table poll_settings enable row level security;
alter table votes enable row level security;

-- =========================================================
-- 1. profiles：本人可读写自己的资料行；is_admin 禁止被本人改动
-- =========================================================
drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles
  for select using (id = auth.uid());

drop policy if exists "profiles_insert_own" on profiles;
create policy "profiles_insert_own" on profiles
  for insert with check (id = auth.uid());

drop policy if exists "profiles_update_own" on profiles;
create policy "profiles_update_own" on profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- 关键：即使上面的 update 策略允许本人更新自己的行，
-- 也要用触发器强制 is_admin 不能被本人（非 service_role）改动，
-- 防止有人在浏览器里直接调用 supabase.from('profiles').update({is_admin:true})。
create or replace function public.prevent_is_admin_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.is_admin is distinct from old.is_admin then
    new.is_admin := old.is_admin;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_is_admin_self_escalation on profiles;
create trigger trg_prevent_is_admin_self_escalation
before update on profiles
for each row execute function public.prevent_is_admin_self_escalation();

-- 要把某个用户设为管理员，请直接在 Supabase Table Editor / SQL Editor
-- 里手动执行：update profiles set is_admin = true where id = '目标用户的 uuid';

-- =========================================================
-- 2. polls：已发布的对所有人可见；管理员可见并可增删改全部
-- =========================================================
drop policy if exists "polls_select_public_or_admin" on polls;
create policy "polls_select_public_or_admin" on polls
  for select using (
    is_published = true
    or created_by = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists "polls_admin_write" on polls;
create policy "polls_admin_write" on polls
  for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  )
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- 建议给 public_id 加唯一约束，作为"数字编号不能重复"的最终防线
-- （前端已经做了重试生成，这里是数据库兜底）：
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'polls_public_id_key'
  ) then
    alter table polls add constraint polls_public_id_key unique (public_id);
  end if;
end $$;

-- =========================================================
-- 3. poll_options / poll_settings：跟随所属 poll 的可见性；
--    只有管理员可以增删改
-- =========================================================
drop policy if exists "poll_options_select" on poll_options;
create policy "poll_options_select" on poll_options
  for select using (
    exists (
      select 1 from polls p
      where p.id = poll_options.poll_id
        and (p.is_published = true or p.created_by = auth.uid()
             or exists (select 1 from profiles pr where pr.id = auth.uid() and pr.is_admin = true))
    )
  );

drop policy if exists "poll_options_admin_write" on poll_options;
create policy "poll_options_admin_write" on poll_options
  for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  )
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists "poll_settings_select" on poll_settings;
create policy "poll_settings_select" on poll_settings
  for select using (
    exists (
      select 1 from polls p
      where p.id = poll_settings.poll_id
        and (p.is_published = true or p.created_by = auth.uid()
             or exists (select 1 from profiles pr where pr.id = auth.uid() and pr.is_admin = true))
    )
  );

drop policy if exists "poll_settings_admin_write" on poll_settings;
create policy "poll_settings_admin_write" on poll_settings
  for all using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  )
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- =========================================================
-- 4. votes：本人只能读/写自己的投票行；插入时数据库校验投票是否
--    "已发布 + 未关闭 + 在时间窗口内"，不是靠前端 JS 判断
-- =========================================================
drop policy if exists "votes_select_own_or_admin" on votes;
create policy "votes_select_own_or_admin" on votes
  for select using (
    user_id = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists "votes_insert_own" on votes;
create policy "votes_insert_own" on votes
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from polls p
      where p.id = votes.poll_id
        and p.is_published = true
        and p.is_closed = false
        and now() >= p.start_time
        and now() <= p.end_time
    )
  );

drop policy if exists "votes_admin_delete" on votes;
create policy "votes_admin_delete" on votes
  for delete using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  );
-- 注意：没有给普通用户开放 update / delete，也就是投票一旦提交不能改票，
-- 这也是常见投票系统的预期行为。

-- =========================================================
-- 5. 多选投票支持（可选，但如果你要在后台勾选"允许多选"，必须执行）
--
-- 现有 UNIQUE (poll_id, user_id) 意味着每个用户在每场投票里
-- 只能有一行 votes 记录，天然只支持单选。要支持多选，需要把
-- 唯一约束放宽到 (poll_id, user_id, option_id)，同时用触发器
-- 在"未开启多选"的投票上继续强制只能投一票。
-- =========================================================
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'votes'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%poll_id%user_id%'
      and pg_get_constraintdef(oid) not ilike '%option_id%'
  loop
    execute format('alter table votes drop constraint %I', c.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'votes_poll_user_option_key'
  ) then
    alter table votes add constraint votes_poll_user_option_key unique (poll_id, user_id, option_id);
  end if;
end $$;

create or replace function public.enforce_vote_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allow_multi boolean;
begin
  select coalesce(ps.allow_multiple_choices, false) into v_allow_multi
  from poll_settings ps where ps.poll_id = new.poll_id;

  if not v_allow_multi then
    if exists (select 1 from votes where poll_id = new.poll_id and user_id = new.user_id) then
      raise exception 'ALREADY_VOTED' using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_vote_rules on votes;
create trigger trg_enforce_vote_rules
before insert on votes
for each row execute function public.enforce_vote_rules();

-- 在没有执行本节 SQL 之前：allow_multiple_choices 开关在后台仍然可以
-- 勾选和保存，但由于原有的 UNIQUE(poll_id, user_id) 约束，用户选择
-- 第二个选项时会收到"您已经投过票了"的提示，实际效果等同单选。

-- =========================================================
-- 6. 结果统计：用 SECURITY DEFINER 函数返回"聚合票数"，
--    既不需要向所有人开放 votes 表的逐行 SELECT（会暴露谁投了谁），
--    又能在满足"结束前显示结果"等条件时正确统计。
-- =========================================================
create or replace function public.get_poll_results(p_public_id text)
returns table(option_id uuid, option_text text, option_order int, vote_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_poll record;
begin
  select id, is_published, is_closed, start_time, end_time
  into v_poll
  from polls
  where public_id = p_public_id;

  if v_poll is null then
    raise exception 'POLL_NOT_FOUND';
  end if;

  if not v_poll.is_published then
    raise exception 'NOT_PERMITTED';
  end if;

  if not (
    v_poll.is_closed
    or now() > v_poll.end_time
    or exists (select 1 from poll_settings ps where ps.poll_id = v_poll.id and ps.show_results_before_end = true)
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin = true)
  ) then
    raise exception 'RESULTS_NOT_VISIBLE_YET';
  end if;

  return query
  select po.id, po.option_text, po.option_order, count(v.id)
  from poll_options po
  left join votes v on v.option_id = po.id
  where po.poll_id = v_poll.id
  group by po.id, po.option_text, po.option_order
  order by po.option_order;
end;
$$;

grant execute on function public.get_poll_results(text) to anon, authenticated;
```

### 为什么需要这些 SQL，而不是直接放开前端权限？

- **不能靠前端 `is_admin` 变量放行数据库写操作**——上面第 2、3 节的
  `polls_admin_write` / `poll_options_admin_write` / `poll_settings_admin_write`
  策略才是真正拦住"改 JS 变量伪装成管理员"的防线。`admin.html` 里的
  `Auth.requireAdminOrRedirect()` 只是不让普通用户看到管理界面，不是安全边界。
- **不能只靠 JS 判断"是否已经投过票"**——真正防重复投票的是
  `UNIQUE(poll_id, user_id)`（或第 5 节改造后的 `(poll_id, user_id, option_id)`
  + 触发器）和 `votes_insert_own` 里对投票时间窗口 / 发布状态 / 关闭状态
  的 `with check`。前端的"您已投票"提示只是提前给用户一个友好反馈。
- **结果统计没有直接开放 `votes` 表的公开 SELECT**，因为逐行暴露
  `user_id + option_id` 会泄露"谁投了谁"，所以用一个只返回聚合票数的
  `SECURITY DEFINER` 函数 `get_poll_results()`，而且函数内部自己判断了
  "投票是否已发布 / 结果是否允许在结束前查看"，不依赖前端传参数来决定
  能不能看结果。

## 已知限制

- `poll_settings.randomize_options` 目前是**每次打开页面时前端随机排
  一次序**，不是"每个用户固定一个随机顺序"。如果需要稳定的每用户随机
  顺序，需要额外的存储方案，这里没有实现。
- `votes` 表没有给普通用户开放 update/delete，即投票后不能改票/撤票，
  如果你需要"允许改票"，需要另外设计策略，这里按照更常见的"投票不可
  更改"来实现。
