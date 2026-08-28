/* ============================================================
   js/login.js
   登录页逻辑：supabase.auth.signInWithPassword()
   支持 ?redirect=xxx.html 参数，登录成功后跳转回原页面。
   ============================================================ */

(function () {
  function getRedirectTarget() {
    const target = Utils.qs("redirect");
    if (!target) return "index.html";
    // 只允许跳转到站内相对路径，避免开放重定向风险
    if (/^https?:\/\//i.test(target) || target.startsWith("//")) {
      return "index.html";
    }
    return target;
  }

  async function checkAlreadyLoggedIn() {
    const { user } = await Auth.getCurrentUserAndProfile();
    if (user) {
      document.getElementById("already-logged-in").style.display = "";
      document.getElementById("login-form").style.display = "none";
    }
  }

  function showError(message) {
    const box = document.getElementById("login-error");
    box.textContent = message;
    box.style.display = "";
  }

  function hideError() {
    document.getElementById("login-error").style.display = "none";
  }

  async function handleSubmit(e) {
    e.preventDefault();
    hideError();

    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const submitBtn = document.getElementById("login-submit");

    if (!email || !password) {
      showError("请填写邮箱和密码。");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "登录中...";

    const { error } = await window.sb.auth.signInWithPassword({ email, password });

    submitBtn.disabled = false;
    submitBtn.textContent = "登 录";

    if (error) {
      showError(Utils.friendlyError(error, "login"));
      return;
    }

    window.location.href = getRedirectTarget();
  }

  document.addEventListener("DOMContentLoaded", () => {
    Auth.initToolbar("toolbar");
    checkAlreadyLoggedIn();
    document.getElementById("login-form").addEventListener("submit", handleSubmit);
  });
})();
