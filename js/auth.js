/* ============================================================
   js/auth.js
   全站共用的登录状态处理：
   - 监听 supabase.auth.onAuthStateChange()
   - 渲染顶部工具条 (登录/注册 或 用户名/退出登录/管理后台)
   - 提供获取当前用户 + profile 的辅助函数
   - 提供 admin.html 使用的权限跳转辅助函数

   重要：这里的 is_admin 判断只用于控制 UI 显示/跳转，
   真正的数据库读写权限完全依赖 Supabase RLS 策略，
   前端不能，也不应该作为权限的最终防线。
   ============================================================ */

(function () {
  let cachedProfile = null;
  let cachedUserId = null;

  async function fetchProfile(userId) {
    if (!userId) return null;
    if (cachedProfile && cachedUserId === userId) return cachedProfile;

    const { data, error } = await window.sb
      .from("profiles")
      .select("id, username, display_name, is_admin, verification_status")
      .eq("id", userId)
      .single();

    if (error) {
      console.warn("[auth.js] 读取 profile 失败：", error.message);
      return null;
    }
    cachedProfile = data;
    cachedUserId = userId;
    return data;
  }

  function clearProfileCache() {
    cachedProfile = null;
    cachedUserId = null;
  }

  async function getCurrentUserAndProfile() {
    const { data, error } = await window.sb.auth.getSession();
    if (error || !data.session) {
      return { user: null, profile: null };
    }
    const user = data.session.user;
    const profile = await fetchProfile(user.id);
    return { user, profile };
  }

  function toolbarHtml(user, profile) {
    if (!user) {
      return `
        <span>👤 访客</span>
        <span class="toolbar__spacer"></span>
        <a class="button-link" href="login.html"><button>登录</button></a>
        <a class="button-link" href="register.html"><button>注册</button></a>
      `;
    }

    const name = Utils.escapeHtml(profile ? (profile.display_name || profile.username) : user.email);
    const adminLink = profile && profile.is_admin
      ? `<a class="button-link" href="admin.html"><button>🛠 管理后台</button></a>`
      : "";

    const vStatus = (profile && profile.verification_status) || "unverified";
    const vMap = {
      unverified: { label: "未验证", cls: "badge--draft" },
      pending: { label: "审核中", cls: "badge--upcoming" },
      verified: { label: "已验证", cls: "badge--live" },
      rejected: { label: "被拒绝", cls: "badge--ended" },
    };
    const vInfo = vMap[vStatus] || vMap.unverified;

    return `
      <span class="toolbar__user">👤 ${name}</span>
      <a class="button-link" href="verification.html"><span class="badge ${vInfo.cls}" title="点击前往个人资料 / 身份验证">${vInfo.label}</span></a>
      <span class="toolbar__spacer"></span>
      ${adminLink}
      <button id="btn-logout">退出登录</button>
    `;
  }

  async function renderToolbar(containerId) {
    const el = document.getElementById(containerId || "toolbar");
    if (!el) return;

    const { user, profile } = await getCurrentUserAndProfile();
    el.innerHTML = toolbarHtml(user, profile);

    const logoutBtn = document.getElementById("btn-logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        await window.sb.auth.signOut();
        clearProfileCache();
        window.location.href = "index.html";
      });
    }
  }

  function initToolbar(containerId) {
    renderToolbar(containerId);
    window.sb.auth.onAuthStateChange((_event, _session) => {
      clearProfileCache();
      renderToolbar(containerId);
    });
  }

  /**
   * 供 admin.html 使用：要求用户已登录且 is_admin = true，
   * 否则弹出提示并跳转回首页。
   * 注意：这只是为了不让普通用户"看见"管理界面，
   * 真正阻止越权读写的是数据库 RLS 策略。
   */
  async function requireAdminOrRedirect() {
    const { user, profile } = await getCurrentUserAndProfile();
    if (!user) {
      alert("请先登录。");
      window.location.href = "login.html?redirect=admin.html";
      return null;
    }
    if (!profile || !profile.is_admin) {
      alert("您没有管理员权限。");
      window.location.href = "index.html";
      return null;
    }
    return { user, profile };
  }

  window.Auth = {
    initToolbar,
    refreshToolbar: renderToolbar,
    getCurrentUserAndProfile,
    requireAdminOrRedirect,
    clearProfileCache,
  };
})();
