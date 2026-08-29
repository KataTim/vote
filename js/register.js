/* ============================================================
   js/register.js
   注册页逻辑：Supabase Auth 注册

   profiles 由数据库 trigger 自动创建，
   前端不再直接 INSERT profiles。
   ============================================================ */

(function () {

  async function checkAlreadyLoggedIn() {
    const { user } = await Auth.getCurrentUserAndProfile();

    if (user) {
      document.getElementById("already-logged-in").style.display = "";
      document.getElementById("register-form").style.display = "none";
    }
  }

  function showError(message) {
    const box = document.getElementById("register-error");
    box.textContent = message;
    box.style.display = "";
  }

  function hideError() {
    document.getElementById("register-error").style.display = "none";
  }

  function showSuccess(message) {
    const box = document.getElementById("register-success");
    box.textContent = message;
    box.style.display = "";
  }

  async function handleSubmit(e) {
    e.preventDefault();

    hideError();

    const username =
      document.getElementById("reg-username").value.trim();

    const email =
      document.getElementById("reg-email").value.trim();

    const password =
      document.getElementById("reg-password").value;

    const password2 =
      document.getElementById("reg-password2").value;

    const submitBtn =
      document.getElementById("register-submit");

    if (!username || !email || !password || !password2) {
      showError("请完整填写所有字段。");
      return;
    }

    if (password !== password2) {
      showError("两次输入的密码不一致。");
      return;
    }

    if (password.length < 6) {
      showError("密码长度至少需要 6 位。");
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "注册中...";

    try {

      /*
       * 注册 Auth 用户。
       *
       * username 放进 user_metadata，
       * 数据库 trigger 会自动读取它并创建 profiles。
       */
      const { data, error } =
        await window.sb.auth.signUp({
          email: email,
          password: password,

          options: {
            data: {
              username: username
            }
          }
        });

      if (error) {
        showError(
          Utils.friendlyError(error, "register")
        );

        submitBtn.disabled = false;
        submitBtn.textContent = "注 册";

        return;
      }

      /*
       * 如果开启了邮箱确认，
       * signUp 不会返回 session。
       */
      if (!data.session) {

        showSuccess(
          "注册成功。当前项目需要邮箱确认后才能登录。"
        );

        submitBtn.disabled = false;
        submitBtn.textContent = "注 册";

        return;
      }

      /*
       * profiles 已经由数据库 trigger 自动创建，
       * 这里绝对不要再次 INSERT。
       */

      Auth.clearProfileCache();

      window.location.href = "index.html";

    } catch (err) {

      console.error("[register.js]", err);

      showError(
        err?.message || "注册过程中发生未知错误。"
      );

      submitBtn.disabled = false;
      submitBtn.textContent = "注 册";
    }
  }

  document.addEventListener("DOMContentLoaded", () => {

    Auth.initToolbar("toolbar");

    checkAlreadyLoggedIn();

    document
      .getElementById("register-form")
      .addEventListener("submit", handleSubmit);

  });

})();
