/* ============================================================
   js/supabase.js
   全站唯一的 Supabase 初始化文件。
   其他所有 JS 文件都通过 window.sb 使用同一个 client 实例，
   不要在别处重复调用 createClient()。

   这里只使用 Publishable Key（浏览器可公开的匿名 key），
   绝对不要把 service_role key 写在这里或任何前端文件中。
   ============================================================ */

(function () {
  const SUPABASE_URL = "https://nrnzcoazhuogftbaksek.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_RY-0i45ghHqbYp5X1ixV4Q_2Mb1Viz6";

  if (!window.supabase) {
    console.error("[supabase.js] 未检测到 Supabase JS SDK，请确认页面已经在本文件之前加载了 CDN <script>。");
    return;
  }

  // 全站共用的单例 client
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
})();
